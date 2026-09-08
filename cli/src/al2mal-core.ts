import { Effect } from "effect";
import { createMyAnimeListSource } from "@manifold/canonical/sources";
import { errorMessage } from "@manifold/json";

import type { AniListEntry } from "@/anilist";
import type { MalClient, MalMangaUpdate } from "@/mal";
import { normalizeTitle } from "@/migration";

/** AniList MediaListStatus → MAL list_status fields (status + optional reread). */
export const ANILIST_TO_MAL = {
  CURRENT: { status: "reading", is_rereading: false },
  PLANNING: { status: "plan_to_read", is_rereading: false },
  COMPLETED: { status: "completed", is_rereading: false },
  DROPPED: { status: "dropped", is_rereading: false },
  PAUSED: { status: "on_hold", is_rereading: false },
  REPEATING: { status: "reading", is_rereading: true },
} as const satisfies Record<
  string,
  { status: NonNullable<MalMangaUpdate["status"]>; is_rereading: boolean }
>;

type AniListMalStatus = keyof typeof ANILIST_TO_MAL;

const isAniListMalStatus = (status: string): status is AniListMalStatus =>
  Object.hasOwn(ANILIST_TO_MAL, status);

export const malUpdateForAniList = (
  entry: Pick<AniListEntry, "status" | "progress">,
  options: { readonly includeProgress: boolean },
): MalMangaUpdate | undefined => {
  if (!isAniListMalStatus(entry.status)) {return undefined;}
  const mapped = ANILIST_TO_MAL[entry.status];
  const update: MalMangaUpdate = {
    status: mapped.status,
    is_rereading: mapped.is_rereading,
  };
  if (
    options.includeProgress &&
    entry.progress !== undefined &&
    Number.isSafeInteger(entry.progress) &&
    entry.progress >= 0
  ) {
    return { ...update, num_chapters_read: entry.progress };
  }
  return update;
};

export type Al2malMatchMethod = "idMal" | "title-exact" | "title-partial";

export interface Al2malMatched {
  readonly mediaId: number;
  readonly title: string;
  readonly anilistStatus: string;
  readonly malId: number;
  readonly matchedTitle: string;
  readonly method: Al2malMatchMethod;
  readonly update: MalMangaUpdate;
  error?: string;
}

export interface Al2malUnmatched {
  readonly mediaId: number;
  readonly title: string;
  readonly anilistStatus: string;
  readonly progress?: number;
  readonly reason: string;
}

export interface Al2malReport {
  readonly scanned: number;
  readonly matched: readonly Al2malMatched[];
  readonly unmatched: readonly Al2malUnmatched[];
  readonly dryRun: boolean;
  readonly written: number;
  readonly failed: number;
}

export interface Al2malSearchHit {
  readonly id: number;
  readonly title: string;
  readonly aliases: readonly string[];
}

export type Al2malSearch = (
  query: string,
) => Promise<readonly Al2malSearchHit[]>;

/** Public-client MAL title search (no user OAuth). */
export const createMalTitleSearch = (clientId: string, fetcher: typeof fetch = fetch): Al2malSearch => {
  const source = createMyAnimeListSource({ clientId, fetcher });
  return async (query) => {
    const found = await Effect.runPromise(source.search(query, { limit: 10 }));
    return found.flatMap((entry) => {
      const id = Number.parseInt(entry.providerId, 10);
      if (!Number.isSafeInteger(id) || id <= 0) {return [];}
      return [{ id, title: entry.title, aliases: entry.aliases }];
    });
  };
};

const titlePool = (entry: AniListEntry): string[] => {
  const values = new Map<string, string>();
  for (const title of [entry.title, ...(entry.titles ?? [])]) {
    const key = normalizeTitle(title);
    if (key && !values.has(key)) {values.set(key, title.trim());}
  }
  return [...values.values()];
};

const chooseTitleMatch = (
  entry: AniListEntry,
  hits: readonly Al2malSearchHit[],
): { hit: Al2malSearchHit; method: "title-exact" | "title-partial" } | undefined => {
  const wanted = new Set(titlePool(entry).map(normalizeTitle));
  if (wanted.size === 0 || hits.length === 0) {return undefined;}

  const exact = hits.filter((hit) =>
    [hit.title, ...hit.aliases].some((title) => wanted.has(normalizeTitle(title))),
  );
  if (exact.length === 1) {return { hit: exact[0]!, method: "title-exact" };}
  if (exact.length > 1) {return undefined;}

  // Single partial: one hit whose normalized title starts with / is started by a candidate.
  const partial = hits.filter((hit) => {
    const names = [hit.title, ...hit.aliases].map(normalizeTitle).filter(Boolean);
    return names.some((name) =>
      [...wanted].some((want) => name.startsWith(want) || want.startsWith(name)),
    );
  });
  if (partial.length === 1) {return { hit: partial[0]!, method: "title-partial" };}
  return undefined;
};

export const matchAniListToMal = async (
  entry: AniListEntry,
  search: Al2malSearch,
  options: { readonly includeProgress: boolean },
): Promise<
  | { kind: "matched"; value: Al2malMatched }
  | { kind: "unmatched"; value: Al2malUnmatched }
> => {
  const update = malUpdateForAniList(entry, options);
  if (!update) {
    return {
      kind: "unmatched",
      value: {
        mediaId: entry.mediaId,
        title: entry.title,
        anilistStatus: entry.status,
        ...(entry.progress !== undefined && { progress: entry.progress }),
        reason: `Unsupported AniList status: ${entry.status}`,
      },
    };
  }

  if (entry.malId && /^[1-9]\d*$/.test(entry.malId)) {
    return {
      kind: "matched",
      value: {
        mediaId: entry.mediaId,
        title: entry.title,
        anilistStatus: entry.status,
        malId: Number(entry.malId),
        matchedTitle: entry.title,
        method: "idMal",
        update,
      },
    };
  }

  const candidates = new Map<number, Al2malSearchHit>();
  for (const title of titlePool(entry)) {
    for (const hit of await search(title)) {
      candidates.set(hit.id, hit);
    }
  }
  const chosen = chooseTitleMatch(entry, [...candidates.values()]);
  if (!chosen) {
    return {
      kind: "unmatched",
      value: {
        mediaId: entry.mediaId,
        title: entry.title,
        anilistStatus: entry.status,
        ...(entry.progress !== undefined && { progress: entry.progress }),
        reason: candidates.size === 0
          ? "No MAL candidates for title search"
          : "Ambiguous or weak MAL title match",
      },
    };
  }

  return {
    kind: "matched",
    value: {
      mediaId: entry.mediaId,
      title: entry.title,
      anilistStatus: entry.status,
      malId: chosen.hit.id,
      matchedTitle: chosen.hit.title,
      method: chosen.method,
      update,
    },
  };
};

/**
 * Match every AniList manga entry to MAL, then optionally PATCH list status
 * (and chapter progress). Dry-run never writes. Failures are recorded per entry
 * so a rerun can resume after fixing tokens or rate limits.
 */
export const runAl2mal = async (options: {
  readonly entries: readonly AniListEntry[];
  readonly search: Al2malSearch;
  readonly client: Pick<MalClient, "updateManga">;
  readonly dryRun: boolean;
  readonly includeProgress: boolean;
  readonly onMatched?: (entry: Al2malMatched, index: number, total: number) => void;
  readonly onUnmatched?: (entry: Al2malUnmatched, index: number, total: number) => void;
  readonly onWritten?: (done: number, total: number) => void;
}): Promise<Al2malReport> => {
  const matched: Al2malMatched[] = [];
  const unmatched: Al2malUnmatched[] = [];

  for (const [index, entry] of options.entries.entries()) {
    const result = await matchAniListToMal(entry, options.search, {
      includeProgress: options.includeProgress,
    });
    if (result.kind === "matched") {
      matched.push(result.value);
      options.onMatched?.(result.value, index, options.entries.length);
    } else {
      unmatched.push(result.value);
      options.onUnmatched?.(result.value, index, options.entries.length);
    }
  }

  let written = 0;
  let failed = 0;
  if (!options.dryRun) {
    for (const [index, entry] of matched.entries()) {
      try {
        await options.client.updateManga(entry.malId, entry.update);
        written += 1;
      } catch (cause) {
        failed += 1;
        entry.error = errorMessage(cause);
      }
      options.onWritten?.(index + 1, matched.length);
    }
  }

  return {
    scanned: options.entries.length,
    matched,
    unmatched,
    dryRun: options.dryRun,
    written,
    failed,
  };
};
