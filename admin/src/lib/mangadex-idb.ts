/** Admin server/route host (TanStack Start + React). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { isJsonObject, isNumberValue, isStringValue } from "./guards";
import type { MangaDexLibraryItem, MangaDexReadingStatus } from "./mangadex";
import { trusted } from "./trusted-cast";

const DB_NAME = "manifold-admin-mangadex";
const DB_VERSION = 1;
const STORE_ENTRIES = "entries";
const STORE_META = "meta";
const META_SNAPSHOT = "snapshot";

export type MangaDexLibrarySnapshotMeta = {
  readonly fetchedAt: number;
  readonly count: number;
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed")),
    );
    tx.addEventListener("abort", () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted")),
    );
  });

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB open failed")),
    );
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        db.createObjectStore(STORE_ENTRIES, { keyPath: "mangaDexId" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
  });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: IndexedDB boundary parser; validates stored JSON before use
const isLibraryItem = (value: unknown): value is MangaDexLibraryItem => {
  if (!isJsonObject(value) || !isStringValue(value.mangaDexId) || !isStringValue(value.status)) {
    return false;
  }
  return value.entryId === null || isStringValue(value.entryId);
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: IndexedDB boundary parser; validates snapshot meta shape
const isSnapshotMeta = (value: unknown): value is MangaDexLibrarySnapshotMeta =>
  isJsonObject(value) && isNumberValue(value.fetchedAt) && isNumberValue(value.count);

const readAllEntries = async (store: IDBObjectStore): Promise<MangaDexLibraryItem[]> => {
  // SAFETY: IDBRequest.result is typed any; owned store writes MangaDexLibraryItem rows only.
  const raw = trusted<unknown>(await requestToPromise(store.getAll()));
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isLibraryItem);
};

export async function readMangaDexLibraryCache(): Promise<{
  readonly items: readonly MangaDexLibraryItem[];
  readonly meta: MangaDexLibrarySnapshotMeta | undefined;
}> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_ENTRIES, STORE_META], "readonly");
    const items = await readAllEntries(tx.objectStore(STORE_ENTRIES));
    // SAFETY: IDBRequest.result is typed any; meta store only holds MangaDexLibrarySnapshotMeta.
    const metaRaw = trusted<unknown>(
      await requestToPromise(tx.objectStore(STORE_META).get(META_SNAPSHOT)),
    );
    const meta = isSnapshotMeta(metaRaw) ? metaRaw : undefined;
    await txDone(tx);
    return { items, meta };
  } finally {
    db.close();
  }
}

export async function replaceMangaDexLibraryCache(
  items: readonly MangaDexLibraryItem[],
): Promise<MangaDexLibrarySnapshotMeta> {
  const db = await openDb();
  try {
    const meta: MangaDexLibrarySnapshotMeta = {
      fetchedAt: Date.now(),
      count: items.length,
    };
    const tx = db.transaction([STORE_ENTRIES, STORE_META], "readwrite");
    const entriesStore = tx.objectStore(STORE_ENTRIES);
    const metaStore = tx.objectStore(STORE_META);
    entriesStore.clear();
    for (const item of items) {
      entriesStore.put(item);
    }
    metaStore.put(meta, META_SNAPSHOT);
    await txDone(tx);
    return meta;
  } finally {
    db.close();
  }
}

/**
 * Merge a status-scoped refresh into the cached library.
 * - Upserts every returned shelf item (hydrated titles/covers/ratings).
 * - Any cached row previously on `status` but missing from `shelf` is cleared
 *   to unset. A later Refresh all / other-shelf refetch assigns the real status.
 */
export async function mergeMangaDexStatusShelf(
  status: MangaDexReadingStatus,
  shelf: readonly MangaDexLibraryItem[],
): Promise<readonly MangaDexLibraryItem[]> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_ENTRIES, STORE_META], "readwrite");
    const entriesStore = tx.objectStore(STORE_ENTRIES);
    const metaStore = tx.objectStore(STORE_META);
    const existing = await readAllEntries(entriesStore);
    const shelfIds = new Set(shelf.map((item) => item.mangaDexId));
    const byId = new Map(existing.map((item) => [item.mangaDexId, item]));

    for (const item of shelf) {
      const previous = byId.get(item.mangaDexId);
      const merged: MangaDexLibraryItem = {
        ...(previous ?? { mangaDexId: item.mangaDexId, status: item.status, entryId: null }),
        ...item,
        status: item.status || status,
      };
      byId.set(item.mangaDexId, merged);
    }

    for (const item of existing) {
      if ((item.status || "") === status && !shelfIds.has(item.mangaDexId)) {
        byId.set(item.mangaDexId, { ...item, status: "" });
      }
    }

    entriesStore.clear();
    const next = [...byId.values()];
    for (const item of next) {
      entriesStore.put(item);
    }
    metaStore.put(
      { fetchedAt: Date.now(), count: next.length } satisfies MangaDexLibrarySnapshotMeta,
      META_SNAPSHOT,
    );
    await txDone(tx);
    return next;
  } finally {
    db.close();
  }
}

export async function patchMangaDexLibraryEntry(
  mangaDexId: string,
  patch: Partial<MangaDexLibraryItem>,
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_ENTRIES, "readwrite");
    const store = tx.objectStore(STORE_ENTRIES);
    // SAFETY: IDBRequest.result is typed any; entries store only holds MangaDexLibraryItem rows.
    const raw = trusted<unknown>(await requestToPromise(store.get(mangaDexId)));
    if (!isLibraryItem(raw)) {
      await txDone(tx);
      return;
    }
    store.put({ ...raw, ...patch, mangaDexId });
    await txDone(tx);
  } finally {
    db.close();
  }
}
