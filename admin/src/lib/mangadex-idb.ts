/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics newPromise:off */
import { isJsonObject, isFiniteNumber, isString } from "@manifold/json";

import type { MangaDexLibraryItem, MangaDexReadingStatus } from "./mangadex";

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

const isLibraryItem = (value: unknown): value is MangaDexLibraryItem => {
  if (!isJsonObject(value) || !isString(value.mangaDexId) || !isString(value.status)) {
    return false;
  }

  return value.entryId === null || isString(value.entryId);
};

const isSnapshotMeta = (value: unknown): value is MangaDexLibrarySnapshotMeta =>
  isJsonObject(value) && isFiniteNumber(value.fetchedAt) && isFiniteNumber(value.count);

const readAllEntries = async (store: IDBObjectStore): Promise<MangaDexLibraryItem[]> => {
  const raw: unknown = await requestToPromise(store.getAll());

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
    const metaRaw: unknown = await requestToPromise(tx.objectStore(STORE_META).get(META_SNAPSHOT));
    const meta = isSnapshotMeta(metaRaw) ? metaRaw : undefined;
    await txDone(tx);

    return { items, meta };
  } finally {
    db.close();
  }
}

/**
 * Store a full library snapshot. The cache is best-effort: private browsing
 * and blocked storage have no usable IndexedDB, and the page must still work
 * from memory. Returns undefined when nothing could be stored.
 */
export async function replaceMangaDexLibraryCache(
  items: readonly MangaDexLibraryItem[],
): Promise<MangaDexLibrarySnapshotMeta | undefined> {
  try {
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
  } catch {
    return undefined;
  }
}

/**
 * Merge a status-scoped refresh into a library.
 * - Upserts every returned shelf item (hydrated titles/covers/ratings).
 * - Any row previously on `status` but missing from `shelf` is cleared
 *   to unset. A later Refresh all / other-shelf refetch assigns the real status.
 */
const mergeStatusShelf = (
  existing: readonly MangaDexLibraryItem[],
  status: MangaDexReadingStatus,
  shelf: readonly MangaDexLibraryItem[],
): MangaDexLibraryItem[] => {
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

  return [...byId.values()];
};

/**
 * Merge a status-scoped refresh into the cached library and store the result.
 * Without usable IndexedDB the shelf is merged into `current` (the library the
 * page holds in memory) and `meta` is undefined: nothing was stored.
 */
export async function mergeMangaDexStatusShelf(
  status: MangaDexReadingStatus,
  shelf: readonly MangaDexLibraryItem[],
  current: readonly MangaDexLibraryItem[],
): Promise<{
  readonly items: readonly MangaDexLibraryItem[];
  readonly meta: MangaDexLibrarySnapshotMeta | undefined;
}> {
  try {
    const db = await openDb();

    try {
      const tx = db.transaction([STORE_ENTRIES, STORE_META], "readwrite");
      const entriesStore = tx.objectStore(STORE_ENTRIES);
      const metaStore = tx.objectStore(STORE_META);
      const next = mergeStatusShelf(await readAllEntries(entriesStore), status, shelf);

      entriesStore.clear();

      for (const item of next) {
        entriesStore.put(item);
      }

      const meta: MangaDexLibrarySnapshotMeta = { fetchedAt: Date.now(), count: next.length };

      metaStore.put(meta, META_SNAPSHOT);
      await txDone(tx);

      return { items: next, meta };
    } finally {
      db.close();
    }
  } catch {
    return { items: mergeStatusShelf(current, status, shelf), meta: undefined };
  }
}

/** Patch one cached row. Best-effort like the other writes: a failure leaves the cache as it was. */
export async function patchMangaDexLibraryEntry(
  mangaDexId: string,
  patch: Partial<MangaDexLibraryItem>,
): Promise<void> {
  try {
    const db = await openDb();

    try {
      const tx = db.transaction(STORE_ENTRIES, "readwrite");
      const store = tx.objectStore(STORE_ENTRIES);
      // SAFETY: IDBRequest.result is typed any; entries store only holds MangaDexLibraryItem rows.
      const raw: unknown = await requestToPromise(store.get(mangaDexId));

      if (!isLibraryItem(raw)) {
        await txDone(tx);

        return;
      }

      store.put({ ...raw, ...patch, mangaDexId });
      await txDone(tx);
    } finally {
      db.close();
    }
  } catch {
    // The page already shows the new status; only the local copy is stale.
  }
}
