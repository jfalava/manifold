import { Effect } from "effect";
import {
  errorMessage,
  isJsonObject,
  manifoldUserAgent,
  numberField,
  stringField,
} from "@manifold/json";
import {
  createMangaDexClient,
  type MangaDexChapter,
  type MangaDexClient,
  type MangaDexReadingStatus,
} from "@manifold/mangadex";

import type { AniListEntry } from "./anilist";
import type { MangaDexTokenManager } from "./mangadex-token";
import { sleepPromise } from "@/effect-kit";

/** MangaDex global API limit is ~5 req/s; 250ms spacing stays under it. */
const MD_REQUEST_INTERVAL_MS = 250;

const sleep = sleepPromise;

export const ANILIST_TO_MANGADEX_STATUS = {
  CURRENT: "reading",
  REPEATING: "re_reading",
  COMPLETED: "completed",
  PAUSED: "on_hold",
  DROPPED: "dropped",
  PLANNING: "plan_to_read",
} as const satisfies Record<string, MangaDexReadingStatus>;

type AniListMangaDexStatus = keyof typeof ANILIST_TO_MANGADEX_STATUS;

const isAniListMangaDexStatus = (status: string): status is AniListMangaDexStatus =>
  Object.hasOwn(ANILIST_TO_MANGADEX_STATUS, status);

const mangaDexStatusFor = (anilistStatus: string): MangaDexReadingStatus | undefined =>
  isAniListMangaDexStatus(anilistStatus) ? ANILIST_TO_MANGADEX_STATUS[anilistStatus] : undefined;

export interface MigrationOptions {
  /** Push chapter read markers up to each entry's AniList progress. */
  readonly includeProgress: boolean;
  readonly dryRun: boolean;
}

export interface MatchedEntry {
  readonly mediaId: number;
  readonly title: string;
  readonly anilistStatus: string;
  readonly mangadexStatus?: MangaDexReadingStatus;
  readonly progress?: number;
  readonly mangaDexId: string;
  readonly matchedTitle: string;
  readonly matchMethod: "links-al" | "title-exact" | "title-prefix";
  /** Chapters that will be marked read for backfill. */
  readonly chaptersToMark: number;
  error?: string;
}

export interface UnmatchedEntry {
  readonly mediaId: number;
  readonly title: string;
  readonly anilistStatus: string;
  readonly progress?: number;
  reason: string;
}

export interface MigrationReport {
  readonly scanned: number;
  readonly matched: readonly MatchedEntry[];
  readonly unmatched: readonly UnmatchedEntry[];
  /** True when no write was performed. */
  readonly dryRun: boolean;
}

/** Normalized compare used by the existing MD→AL migration, inverted. */
export const normalizeTitle = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Runs one migration pass: fetches the AniList manga list, matches every
 * entry to a MangaDex manga (links.al direct hit first, then title search),
 * and applies reading status + chapter-marker backfill on MangaDex.
 *
 * Matching performs live MangaDex searches and is rate-limited; applying is
 * skipped entirely in dry-run mode.
 */
export const runMigration = async (
  anilistEntries: readonly AniListEntry[],
  tokenManager: MangaDexTokenManager,
  options: MigrationOptions,
): Promise<MigrationReport> => {
  const client = createClient(tokenManager);

  const matched: MatchedEntry[] = [];
  const unmatched: UnmatchedEntry[] = [];

  for (const [index, entry] of anilistEntries.entries()) {
    if (index > 0) {
      await sleep(MD_REQUEST_INTERVAL_MS);
    }
    const mangadexStatus = mangaDexStatusFor(entry.status);

    try {
      const match = await matchMangaDex(client, entry);
      if (!match) {
        unmatched.push({
          mediaId: entry.mediaId,
          title: entry.title,
          anilistStatus: entry.status,
          ...(entry.progress !== undefined && { progress: entry.progress }),
          reason: "No MangaDex candidate matched",
        });
        continue;
      }

      let chaptersToMark = 0;
      if (options.includeProgress && entry.progress !== undefined && entry.progress >= 1) {
        await sleep(MD_REQUEST_INTERVAL_MS);
        const chapterIds = await chapterIdsUpTo(client, match.manga.id, entry.progress);
        chaptersToMark = chapterIds.length;
        if (!options.dryRun && chapterIds.length > 0) {
          await client.markChaptersRead(match.manga.id, chapterIds);
        }
      }

      if (!options.dryRun && mangadexStatus) {
        await sleep(MD_REQUEST_INTERVAL_MS);
        await client.updateReadingStatus(match.manga.id, mangadexStatus);
      }

      matched.push({
        mediaId: entry.mediaId,
        title: entry.title,
        anilistStatus: entry.status,
        ...(mangadexStatus && { mangadexStatus }),
        ...(entry.progress !== undefined && { progress: entry.progress }),
        mangaDexId: match.manga.id,
        matchedTitle: match.manga.title,
        matchMethod: match.method,
        chaptersToMark,
      });
    } catch (cause) {
      matched.push({
        mediaId: entry.mediaId,
        title: entry.title,
        anilistStatus: entry.status,
        ...(mangadexStatus && { mangadexStatus }),
        ...(entry.progress !== undefined && { progress: entry.progress }),
        mangaDexId: "",
        matchedTitle: "",
        matchMethod: "links-al",
        chaptersToMark: 0,
        error: cause instanceof Error ? cause.message : `Unknown failure: ${errorMessage(cause)}`,
      });
    }
  }

  return {
    scanned: anilistEntries.length,
    matched,
    unmatched,
    dryRun: options.dryRun,
  };
};

type WithRetry = <A>(action: () => Promise<A>) => Promise<A>;

interface MangaDexAuthErrorPayload {
  readonly _tag?: string;
  readonly status?: number;
}

const isAuthFailure = (cause: unknown): cause is MangaDexAuthErrorPayload => {
  if (!isJsonObject(cause)) {
    return false;
  }
  return (
    stringField(cause, "_tag") === "MangaDexSourceError" &&
    (numberField(cause, "status") === 401 || numberField(cause, "status") === 403)
  );
};

/** Minimal promise-returning view over the Effect-based MangaDex client. */
interface MangaDexAsyncClient {
  search: (query: string) => Promise<readonly { id: string; title: string; anilistId?: string }[]>;
  getChapters: (mangaId: string) => Promise<readonly MangaDexChapter[]>;
  markChaptersRead: (mangaId: string, chapterIds: readonly string[]) => Promise<void>;
  updateReadingStatus: (mangaId: string, status: MangaDexReadingStatus | null) => Promise<void>;
}

/**
 * Creates a promise-based MangaDex client bound to a token manager. A single
 * auth failure triggers one token refresh + retry before failing.
 */
const createClient = (tokenManager: MangaDexTokenManager): MangaDexAsyncClient => {
  const withAuthRetry: WithRetry = async (action) => {
    try {
      return await action();
    } catch (error) {
      if (isAuthFailure(error)) {
        tokenManager.invalidate();
        return action();
      }
      throw error;
    }
  };

  const call = async <A, E>(
    invoke: (client: MangaDexClient) => Effect.Effect<A, E>,
  ): Promise<A> =>
    withAuthRetry(async () => {
      const token = await tokenManager.current();
      const client = createMangaDexClient({
        accessToken: token,
        userAgent: manifoldUserAgent("cli"),
      });
      return Effect.runPromise(invoke(client));
    });

  return {
    search: (query) => call((client) => client.search(query)),
    getChapters: (mangaId) => call((client) => client.getChapters(mangaId)),
    markChaptersRead: (mangaId, chapterIds) =>
      call((client) => client.markChaptersRead(mangaId, chapterIds)),
    updateReadingStatus: (mangaId, status) =>
      call((client) => client.updateReadingStatus(mangaId, status)),
  };
};

interface TitleMatch {
  readonly manga: { id: string; title: string };
  readonly method: MatchedEntry["matchMethod"];
}

const toMatch = (
  manga: { id: string; title: string },
  normalizedTarget: string,
): TitleMatch | undefined => {
  const candidates = [manga.title].filter(Boolean).map(normalizeTitle);
  if (candidates.includes(normalizedTarget)) {
    return { manga, method: "title-exact" };
  }
  if (candidates.some((candidate) => candidate.startsWith(normalizedTarget))) {
    return { manga, method: "title-prefix" };
  }
  return undefined;
};

const matchMangaDex = async (
  client: MangaDexAsyncClient,
  entry: AniListEntry,
): Promise<TitleMatch | undefined> => {
  const normalized = normalizeTitle(entry.title);

  // Prefer a search result whose links.al carries this exact AniList id —
  // the same direct-hit cascade the reverse migration relies on.
  const results = await client.search(entry.title);
  const directHit = results.find((manga) => manga.anilistId === String(entry.mediaId));
  if (directHit) {
    return { manga: { id: directHit.id, title: directHit.title }, method: "links-al" };
  }
  const titleHit = results
    .map((manga) => toMatch({ id: manga.id, title: manga.title }, normalized))
    .find((hit): hit is TitleMatch => hit !== undefined);
  if (titleHit) {
    return titleHit;
  }

  // Retry once with the first three significant words when the full title
  // returned nothing useful.
  const shortened = normalized.split(/\s+/).slice(0, 3).join(" ");
  if (shortened && shortened !== normalized) {
    await sleep(MD_REQUEST_INTERVAL_MS);
    const retry = await client.search(shortened);
    const retryDirect = retry.find((manga) => manga.anilistId === String(entry.mediaId));
    if (retryDirect) {
      return {
        manga: { id: retryDirect.id, title: retryDirect.title },
        method: "links-al",
      };
    }
    const retryHit = retry
      .map((manga) => toMatch({ id: manga.id, title: manga.title }, normalized))
      .find((hit): hit is TitleMatch => hit !== undefined);
    if (retryHit) {
      return retryHit;
    }
  }

  return undefined;
};

/**
 * Collects the IDs of the lowest-numbered chapters up to and including the
 * given progress value, so marking them read reproduces AniList progress.
 */
export const chapterIdsUpTo = async (
  client: MangaDexAsyncClient,
  mangaId: string,
  progress: number,
): Promise<string[]> => {
  const chapters: readonly MangaDexChapter[] = await client.getChapters(mangaId);
  const numbered = chapters
    .filter((chapter) => chapter.chapterNumber !== undefined)
    .sort((a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0));
  const ids: string[] = [];
  for (const chapter of numbered) {
    // SAFETY: value matches number; at this call site
    const number = chapter.chapterNumber as number;
    if (number > progress) {
      break;
    }
    ids.push(chapter.id);
  }
  return ids;
};
