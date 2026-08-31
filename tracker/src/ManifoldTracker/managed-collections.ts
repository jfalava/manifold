import {
  ContentRating,
  type ManagedCollection,
  type ManagedCollectionChangeset,
  type SourceManga,
} from "@paperback/types";

import {
  ANILIST_SESSION_KEY,
  ANILIST_VIEWER_ID_KEY,
  configuredPersonalApi,
  deleteAniListEntry,
  fetchAniListLibrary,
  fetchAniListMediaListEntryIds,
  saveAniListProgress,
  saveAniListStatus,
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

const COLLECTION_IDS = new Set(MANAGED_COLLECTIONS.map((collection) => collection.id));

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

const PENDING_NUKES_KEY = "manifold.pending-nukes";
const NUKE_QUIET_MS = 120_000;

const readPendingNukes = (): Record<string, PendingNuke> => {
  const raw = Application.getState(PENDING_NUKES_KEY);
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Record<string, PendingNuke>;
  } catch {
    return {};
  }
};

const writePendingNukes = (pending: Record<string, PendingNuke>): void => {
  Application.setState(JSON.stringify(pending), PENDING_NUKES_KEY);
};

const aniListToken = (): string => {
  const token = Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined;
  if (!token) {
    throw new Error("Connect AniList in the manifold: tracker settings first");
  }
  return token;
};

const aniListUserId = (): number => {
  const userId = Application.getState(ANILIST_VIEWER_ID_KEY) as number | undefined;
  if (!userId) throw new Error("AniList session is incomplete, reconnect in settings");
  return userId;
};

export const aniListSessionToken = (): string | undefined =>
  (Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined) ?? undefined;

const rememberListEntryId = (
  anilistId: string,
  mediaListEntryId: number | undefined,
): void => {
  if (mediaListEntryId !== undefined) mediaListEntryIds.set(anilistId, mediaListEntryId);
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
  if (stamped) return { entryId, anilistId: stamped };
  const entry = await configuredPersonalApi().getEntry(entryId);
  const anilistId = entry?.providers.find((provider) => provider.provider === "anilist")
    ?.externalId;
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
  if (!token) return false;
  if (typeof chapterNumber !== "number" || !Number.isFinite(chapterNumber) || chapterNumber < 0) {
    return false;
  }
  const resolved = await anilistIdOf(sourceManga).catch(() => undefined);
  if (!resolved) return false;
  return await saveAniListProgress(token, resolved.anilistId, chapterNumber);
};

export const getManagedLibraryCollections = (): Promise<ManagedCollection[]> => {
  console.log("[manifold] collections:list");
  return Promise.resolve([...MANAGED_COLLECTIONS]);
};

export const getSourceMangaInManagedCollection = async (
  managedCollection: ManagedCollection,
): Promise<SourceManga[]> => {
  if (!COLLECTION_IDS.has(managedCollection.id)) return [];
  console.log(`[manifold] collection:fetch:${managedCollection.id}:start`);

  const token = aniListToken();
  const library = await fetchAniListLibrary(token, aniListUserId());
  const items = library.filter((item) => item.status === managedCollection.id);

  // Registry first: every collection card carries the provider-neutral UUID
  // as its Paperback manga id so reads/collections bind to registry rows.
  type ResolvedRow = {
    readonly id: string;
    readonly providers: readonly {
      readonly provider: string;
      readonly externalId: string;
      readonly title?: string;
    }[];
  };
  let byAnilist = new Map<string, ResolvedRow>();
  try {
    const resolved: readonly ResolvedRow[] = await configuredPersonalApi().resolveEntries(
      items.map((item) => ({
        provider: "anilist" as const,
        providerId: item.anilistId,
        title: item.title,
      })),
    );
    byAnilist = new Map(
      resolved.flatMap((entry) => {
        const link = entry.providers.find((provider) => provider.provider === "anilist");
        return link ? [[link.externalId, entry] as const] : [];
      }),
    );
  } catch (error) {
    console.error(
      `[manifold] registry resolve failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return items.map((item) => {
    const entry = byAnilist.get(item.anilistId);
    const uuid = entry?.id;
    const mdLink = entry?.providers.find((provider) => provider.provider === "mangadex");
    return {
      mangaId: uuid ?? `anilist:${item.anilistId}`,
      mangaInfo: {
        thumbnailUrl: item.coverUrl ?? "",
        synopsis: "",
        primaryTitle: item.title,
        secondaryTitles: [],
        contentRating: ContentRating.MATURE,
        additionalInfo: {
          ...(uuid ? { "Canonical ID": uuid } : {}),
          "Canonical provider": "registry",
          "AniList ID": item.anilistId,
          // Stamp the verified reading provider so getChapters goes straight
          // to MangaDex for collection-added titles instead of falling into
          // the Comix path (whose Cloudflare challenge fails library
          // updates for titles that are on MangaDex).
          ...(mdLink
            ? {
                "manifold provider": "mangadex",
                "manifold provider ID": mdLink.externalId,
                ...(mdLink.title ? { "manifold provider title": mdLink.title } : {}),
              }
            : {}),
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
  if (!COLLECTION_IDS.has(changeset.collection.id)) {
    throw new Error(`Unknown manifold collection: ${changeset.collection.id}`);
  }

  const token = aniListToken();
  const api = configuredPersonalApi();
  const status = changeset.collection.id as AniListReadingStatus;
  const pending = readPendingNukes();

  for (const addition of changeset.additions ?? []) {
    const resolved = await anilistIdOf(addition);
    if (!resolved) throw new Error(`No AniList link for ${addition.mangaId}`);
    // An addition for a pending-nuked title means the deletion was one half
    // of a move — cancel the nuke.
    delete pending[resolved.anilistId];
    const result = await saveAniListStatus(token, resolved.anilistId, status);
    rememberListEntryId(resolved.anilistId, result.mediaListEntryId);
    console.log(
      `[manifold] collection:add:${resolved.anilistId}:${status}:entry=${result.mediaListEntryId ?? "?"}`,
    );
    // Device applied it directly; the registry records the new truth without
    // enqueueing a redundant op.
    await api
      .setListState(resolved.entryId, {
        origin: "device",
        appliedRemotely: true,
        status,
      })
      .catch(() => undefined);
  }

  for (const deletion of changeset.deletions ?? []) {
    const resolved = await anilistIdOf(deletion);
    if (!resolved) continue;
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
 * Executes pending nukes that outlived the quiet window. A live-status
 * recheck guards against racing moves: if the entry now sits in a different
 * collection, the deletion was the old half of a move and is cancelled.
 * Called from commitManagedCollectionChanges and the op-drain hook.
 */
export const flushPendingNukes = async (): Promise<number> => {
  const pending = readPendingNukes();
  const nowMs = Date.now();
  const due = Object.entries(pending).filter(([, nuke]) => nowMs - nuke.at >= NUKE_QUIET_MS);
  if (due.length === 0) return 0;

  const token = aniListSessionToken();
  if (!token) return 0;
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
      await api.nukeEntry(nuke.entryId).catch(() => undefined);
      delete pending[anilistId];
      executed += 1;
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
