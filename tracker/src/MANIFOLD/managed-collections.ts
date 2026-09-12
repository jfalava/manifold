/** Paperback / device host callbacks are async by Application contract. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import {
  ContentRating,
  type ManagedCollection,
  type ManagedCollectionChangeset,
  type SourceManga,
} from "@paperback/types";

import { isFiniteNumber, isJsonArray, isJsonObject, isString } from "@manifold/json";
import type { MalBackupIdentity } from "@manifold/canonical";
import {
  ANILIST_SESSION_KEY,
  ANILIST_VIEWER_ID_KEY,
  configuredPersonalApi,
  deleteAniListEntry,
  fetchAniListLibrary,
  fetchAniListMediaListEntryIds,
  parseAniListReadingStatus,
  saveAniListProgress,
  saveAniListStatus,
  safeImageUrl,
  type AniListLibraryItem,
  type PersonalApiClient,
  type AniListReadingStatus,
} from "@manifold/paperback-runtime";

export const MANAGED_COLLECTIONS: ManagedCollection[] = [
  { id: "reading", title: "Reading" },
  { id: "on_hold", title: "On Hold" },
  { id: "plan_to_read", title: "Planned" },
  { id: "dropped", title: "Dropped" },
  { id: "re_reading", title: "Re-reading" },
  { id: "completed", title: "Completed" },
];

// Deletion on AniList is keyed by the numeric list-entry row, not the media
// row. Saves return it; this cache bridges saves and later nukes within a
// session, with a library-wide fetch as the fallback.
const mediaListEntryIds = new Map<string, number>();

// Paperback emits a collection MOVE as deletion-from-old + addition-to-new.
// Nuking on deletion would therefore destroy entries mid-move (observed:
// Reading -> Dropped deleted the AniList entry). Deletions park here and
// only execute as real nukes after a quiet window AND a live-status recheck;
// any addition for the same title cancels the pending nuke.
interface PendingNuke {
  readonly entryId: string;
  readonly anilistId: string;
  readonly collectionId: string;
  readonly at: number;
}

interface PendingNukes {
  [anilistId: string]: PendingNuke;
}

const PENDING_NUKES_KEY = "manifold.pending-nukes";
const NUKE_QUIET_MS = 120_000;
const REGISTRY_RESOLVE_BATCH_SIZE = 50;

// Registry reconciliation (setListState / nukeEntry) must reach the personal
// API even when the call fails: the device applies changes directly, but the
// registry is the cross-device source of truth. Failed reconciles persist in
// Application state — surviving restarts — and retry on every later flush.
type PendingReconcile =
  | {
      readonly kind: "setListState";
      readonly entryId: string;
      readonly status: AniListReadingStatus;
      readonly backupIdentity?: MalBackupIdentity;
      readonly at: number;
    }
  | { readonly kind: "nukeEntry"; readonly entryId: string; readonly at: number };

type PendingReconciles = { [entryId: string]: PendingReconcile };

const PENDING_RECONCILES_KEY = "manifold.pending-reconciles";

const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;

const isMalBackupIdentity = (value: unknown): value is MalBackupIdentity => {
  if (!isJsonObject(value) || !isNonEmptyString(value["anilistId"])) {
    return false;
  }
  if (value["malId"] !== undefined && !isNonEmptyString(value["malId"])) {
    return false;
  }
  return isJsonArray(value["titles"]) && value["titles"].every(isNonEmptyString);
};

const readPendingReconciles = (): PendingReconciles => {
  const raw = Application.getState(PENDING_RECONCILES_KEY);
  if (!isString(raw)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      return {};
    }
    const reconciles: [string, PendingReconcile][] = [];
    for (const [entryId, value] of Object.entries(parsed)) {
      if (!isJsonObject(value) || !isFiniteNumber(value["at"]) || value["at"] < 0) {
        continue;
      }
      if (
        value["kind"] === "setListState" &&
        isString(value["entryId"]) &&
        value["entryId"] === entryId
      ) {
        const status = parseAniListReadingStatus(isString(value["status"]) ? value["status"] : "");
        if (status === undefined) {
          continue;
        }
        const backup = value["backupIdentity"];
        reconciles.push([
          entryId,
          {
            kind: "setListState",
            entryId,
            status,
            ...(isMalBackupIdentity(backup) && { backupIdentity: backup }),
            at: value["at"],
          },
        ]);
      } else if (
        value["kind"] === "nukeEntry" &&
        isString(value["entryId"]) &&
        value["entryId"] === entryId
      ) {
        reconciles.push([entryId, { kind: "nukeEntry", entryId, at: value["at"] }]);
      }
    }
    return Object.fromEntries(reconciles);
  } catch {
    return {};
  }
};

const writePendingReconciles = (pending: PendingReconciles): void => {
  Application.setState(JSON.stringify(pending), PENDING_RECONCILES_KEY);
};

/** Queues a registry reconciliation, superseding any earlier one per entry. */
const enqueueReconcile = (reconcile: PendingReconcile): void => {
  const pending = readPendingReconciles();
  pending[reconcile.entryId] = reconcile;
  writePendingReconciles(pending);
};

/** Drops a reconcile once the registry acknowledged it. */
const acknowledgeReconcile = (entryId: string): void => {
  const pending = readPendingReconciles();
  if (pending[entryId] === undefined) {
    return;
  }
  delete pending[entryId];
  writePendingReconciles(pending);
};

type ResolvedRegistryRow = {
  readonly id: string;
  readonly providers: readonly {
    readonly provider: string;
    readonly externalId: string;
    readonly title?: string;
  }[];
};

const readPendingNukes = (): PendingNukes => {
  const raw = Application.getState(PENDING_NUKES_KEY);
  if (!isString(raw)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      return {};
    }
    const pending: PendingNukes = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        !isJsonObject(value) ||
        !isString(value["entryId"]) ||
        !isString(value["anilistId"]) ||
        key !== value["anilistId"] ||
        !isString(value["collectionId"]) ||
        parseAniListReadingStatus(value["collectionId"]) === undefined ||
        !isFiniteNumber(value["at"]) ||
        !Number.isSafeInteger(value["at"]) ||
        value["at"] < 0
      ) {
        continue;
      }
      pending[key] = {
        entryId: value["entryId"],
        anilistId: value["anilistId"],
        collectionId: value["collectionId"],
        at: value["at"],
      };
    }
    return pending;
  } catch {
    return {};
  }
};

const writePendingNukes = (pending: PendingNukes): void => {
  Application.setState(JSON.stringify(pending), PENDING_NUKES_KEY);
};

const aniListToken = (): string => {
  const token = Application.getSecureState(ANILIST_SESSION_KEY);
  if (!isString(token) || token.trim().length === 0) {
    throw new Error("Connect AniList in the manifold: tracker settings first");
  }
  return token.trim();
};

const aniListUserId = (): number => {
  const raw = Application.getState(ANILIST_VIEWER_ID_KEY);
  if (!isString(raw) && !isFiniteNumber(raw)) {
    throw new Error("AniList session is incomplete, reconnect in settings");
  }
  const userId = Number(raw);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("AniList session is incomplete, reconnect in settings");
  }
  return userId;
};

export const aniListSessionToken = (): string | undefined => {
  const token = Application.getSecureState(ANILIST_SESSION_KEY);
  return isString(token) && token.trim().length > 0 ? token.trim() : undefined;
};

const rememberListEntryId = (anilistId: string, mediaListEntryId: number | undefined): void => {
  if (mediaListEntryId !== undefined) {
    mediaListEntryIds.set(anilistId, mediaListEntryId);
  }
};

/**
 * Resolves a registry UUID manga id to its AniList external id, preferring
 * the value stamped into SourceManga additionalInfo over an API round trip.
 */
const anilistIdOf = async (
  sourceManga: SourceManga,
): Promise<{ readonly entryId: string; readonly anilistId: string } | undefined> => {
  const entryId = sourceManga.mangaId;
  const stamped = sourceManga.mangaInfo.additionalInfo?.["AniList ID"];
  if (stamped) {
    return { entryId, anilistId: stamped };
  }
  const entry = await configuredPersonalApi().getEntry(entryId);
  const anilistId = entry?.providers.find(
    (provider) => provider.provider === "anilist",
  )?.externalId;
  return anilistId ? { entryId, anilistId } : undefined;
};

/**
 * Pushes a chapter read to the AniList entry WITHOUT touching its status —
 * managed collections are the sole status authority. Reading a DROPPED title
 * bumps progress and stays DROPPED. Returns false when there is nothing to
 * do (no AniList link, or AniList not connected).
 */
export const recordAniListProgress = async (
  sourceManga: SourceManga,
  chapterNumber: number | undefined,
): Promise<boolean> => {
  const token = aniListSessionToken();
  if (!token) {
    return false;
  }
  if (!isFiniteNumber(chapterNumber) || chapterNumber < 0) {
    return false;
  }
  const resolved = await anilistIdOf(sourceManga).catch(() => undefined);
  if (!resolved) {
    return false;
  }
  return await saveAniListProgress(token, resolved.anilistId, chapterNumber);
};

export const getManagedLibraryCollections = (): Promise<ManagedCollection[]> => {
  console.log("[manifold] collections:list");
  return Promise.resolve([...MANAGED_COLLECTIONS]);
};

export const resolveManagedCollectionEntries = async (
  items: readonly AniListLibraryItem[],
  api: Pick<PersonalApiClient, "resolveEntries">,
): Promise<ReadonlyMap<string, ResolvedRegistryRow>> => {
  const byAnilist = new Map<string, ResolvedRegistryRow>();
  for (let index = 0; index < items.length; index += REGISTRY_RESOLVE_BATCH_SIZE) {
    const chunk = items.slice(index, index + REGISTRY_RESOLVE_BATCH_SIZE);
    try {
      const resolved = await api.resolveEntries(
        chunk.map((item) => ({
          provider: "anilist" as const,
          providerId: item.anilistId,
          title: item.title,
        })),
      );
      for (const entry of resolved) {
        const link = entry.providers.find((provider) => provider.provider === "anilist");
        if (link) {
          byAnilist.set(link.externalId, entry);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[manifold] registry resolve batch failed:${index}-${index + chunk.length - 1}:` + detail,
      );
    }
  }
  return byAnilist;
};

export const getSourceMangaInManagedCollection = async (
  managedCollection: ManagedCollection,
): Promise<SourceManga[]> => {
  const status = parseAniListReadingStatus(managedCollection.id);
  if (status === undefined) {
    return [];
  }
  console.log(`[manifold] collection:fetch:${managedCollection.id}:start`);

  const token = aniListToken();
  const library = await fetchAniListLibrary(token, aniListUserId());
  const items = library.filter((item) => item.status === status);

  // Registry first: every collection card carries the provider-neutral UUID
  // as its Paperback manga id so reads/collections bind to registry rows.
  const byAnilist = await resolveManagedCollectionEntries(items, configuredPersonalApi());

  return items.map((item) => {
    const entry = byAnilist.get(item.anilistId);
    const uuid = entry?.id;
    return {
      mangaId: uuid ?? `anilist:${item.anilistId}`,
      mangaInfo: {
        thumbnailUrl: safeImageUrl(item.coverUrl),
        synopsis: "",
        primaryTitle: item.title,
        secondaryTitles: [],
        contentRating: ContentRating.MATURE,
        additionalInfo: {
          ...(uuid && { "Canonical ID": uuid }),
          "Canonical provider": "registry",
          "AniList ID": item.anilistId,
        },
      },
    };
  });
};

export const commitManagedCollectionChanges = async (
  changeset: ManagedCollectionChangeset,
): Promise<void> => {
  const addedIds = (changeset.additions ?? []).map((manga) => manga.mangaId);
  const deletedIds = (changeset.deletions ?? []).map((manga) => manga.mangaId);
  console.log(
    `[manifold] collection:commit:${changeset.collection.id}:` +
      `add=[${addedIds.join(",")}]:del=[${deletedIds.join(",")}]`,
  );
  const status = parseAniListReadingStatus(changeset.collection.id);
  if (status === undefined) {
    throw new Error(`Unknown manifold collection: ${changeset.collection.id}`);
  }

  const token = aniListToken();
  const api = configuredPersonalApi();
  const pending = readPendingNukes();

  for (const addition of changeset.additions ?? []) {
    const resolved = await anilistIdOf(addition);
    if (!resolved) {
      throw new Error(`No AniList link for ${addition.mangaId}`);
    }
    // An addition for a pending-nuked title means the deletion was one half
    // of a move — cancel the nuke.
    delete pending[resolved.anilistId];
    const result = await saveAniListStatus(token, resolved.anilistId, status);
    rememberListEntryId(resolved.anilistId, result.mediaListEntryId);
    console.log(
      `[manifold] collection:add:${resolved.anilistId}:${status}:entry=${result.mediaListEntryId ?? "?"}`,
    );
    // Device applied it directly; the registry records the new truth without
    // enqueueing a redundant op. The reconcile persists until acknowledged so
    // a failed API call retries across flushes and restarts.
    enqueueReconcile({
      kind: "setListState",
      entryId: resolved.entryId,
      status,
      ...(result.backupIdentity && { backupIdentity: result.backupIdentity }),
      at: Date.now(),
    });
    try {
      await api.setListState(resolved.entryId, {
        origin: "device",
        appliedRemotely: true,
        status,
        ...(result.backupIdentity && { backupIdentity: result.backupIdentity }),
      });
      acknowledgeReconcile(resolved.entryId);
    } catch (error) {
      console.error(
        `[manifold] registry setListState failed, queued for retry:${resolved.entryId}:` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  for (const deletion of changeset.deletions ?? []) {
    const resolved = await anilistIdOf(deletion);
    if (!resolved) {
      continue;
    }
    pending[resolved.anilistId] = {
      entryId: resolved.entryId,
      anilistId: resolved.anilistId,
      collectionId: changeset.collection.id,
      at: Date.now(),
    };
  }
  writePendingNukes(pending);

  await flushPendingNukes();
};

/**
 * Executes pending nukes that outlived the quiet window, then retries any
 * queued registry reconciliations. A live-status recheck guards against
 * racing moves: if the entry now sits in a different collection, the
 * deletion was the old half of a move and is cancelled. Called from
 * commitManagedCollectionChanges and the op-drain hook.
 */
export const flushPendingNukes = async (): Promise<number> => {
  const executed = await flushDueNukes();
  // Reconcile retries run on every flush, even when no nukes were due.
  await flushPendingReconciles();
  return executed;
};

const flushDueNukes = async (): Promise<number> => {
  const pending = readPendingNukes();
  const nowMs = Date.now();
  const due = Object.entries(pending).filter(([, nuke]) => nowMs - nuke.at >= NUKE_QUIET_MS);
  if (due.length === 0) {
    return 0;
  }

  const token = aniListSessionToken();
  if (!token) {
    return 0;
  }
  const api = configuredPersonalApi();

  let userId: number | undefined;
  try {
    userId = aniListUserId();
  } catch {
    return 0;
  }

  let library = new Map<string, AniListReadingStatus>();
  try {
    library = new Map(
      (await fetchAniListLibrary(token, userId)).map((item) => [item.anilistId, item.status]),
    );
  } catch (error) {
    console.error(
      `[manifold] nuke flush library fetch failed:${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }

  let executed = 0;
  for (const [anilistId, nuke] of due) {
    const live = library.get(anilistId);
    if (live !== undefined && live !== nuke.collectionId) {
      // The entry moved to another collection — not a removal.
      delete pending[anilistId];
      continue;
    }
    try {
      let listEntryId = mediaListEntryIds.get(anilistId);
      if (listEntryId === undefined) {
        const ids = await fetchAniListMediaListEntryIds(token, userId);
        listEntryId = ids[anilistId];
      }
      if (listEntryId !== undefined) {
        await deleteAniListEntry(token, listEntryId);
        mediaListEntryIds.delete(anilistId);
      } else {
        console.log(`[manifold] nuke skipped, unlisted:${anilistId}`);
      }
      // The AniList side is resolved; drop the pending nuke now. The registry
      // reconciliation persists separately until nukeEntry is acknowledged.
      delete pending[anilistId];
      executed += 1;
      enqueueReconcile({ kind: "nukeEntry", entryId: nuke.entryId, at: nowMs });
      try {
        await api.nukeEntry(nuke.entryId);
        acknowledgeReconcile(nuke.entryId);
      } catch (error) {
        console.error(
          `[manifold] registry nukeEntry failed, queued for retry:${nuke.entryId}:` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      console.log(`[manifold] nuked:${anilistId}:${nuke.entryId}`);
    } catch (error) {
      // Keep it pending; the next flush retries.
      console.error(
        `[manifold] nuke failed:${anilistId}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  writePendingNukes(pending);
  return executed;
};

/**
 * Retries registry reconciliations that earlier commits or nukes queued:
 * failed setListState / nukeEntry calls stay in Application state until the
 * registry acknowledges them, across flushes and restarts.
 */
export const flushPendingReconciles = async (
  api: Pick<PersonalApiClient, "setListState" | "nukeEntry"> = configuredPersonalApi(),
): Promise<number> => {
  const pending = readPendingReconciles();
  let acknowledged = 0;
  for (const [entryId, reconcile] of Object.entries(pending)) {
    try {
      if (reconcile.kind === "setListState") {
        await api.setListState(entryId, {
          origin: "device",
          appliedRemotely: true,
          status: reconcile.status,
          ...(reconcile.backupIdentity && { backupIdentity: reconcile.backupIdentity }),
        });
      } else {
        await api.nukeEntry(entryId);
      }
      acknowledgeReconcile(entryId);
      acknowledged += 1;
      console.log(`[manifold] registry reconcile acknowledged:${entryId}:${reconcile.kind}`);
    } catch (error) {
      // Keep it queued; the next flush retries.
      console.error(
        `[manifold] registry reconcile retry failed:${entryId}:${reconcile.kind}:` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return acknowledged;
};
