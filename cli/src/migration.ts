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
  type MangaDexSourceError,
} from "@manifold/mangadex";

import type { AniListEntry } from "./anilist";
import type { MangaDexTokenManager } from "./mangadex-token";
import { fromPromise, runHost, sleep } from "@/effect-kit";

/** MangaDex global API limit is ~5 req/s; 250ms spacing stays under it. */
const MD_REQUEST_INTERVAL_MS = 250;

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

/**
 * Runs an Effect against a fresh MangaDex client bound to the current token.
 * A single auth failure triggers one token refresh + retry before failing.
 */
const withMangaDexClient = <A>(
  tokenManager: MangaDexTokenManager,
  invoke: (client: MangaDexClient) => Effect.Effect<A, MangaDexSourceError>,
): Effect.Effect<A, unknown> =>
  Effect.gen(function* () {
    const attempt = (forceRefresh: boolean): Effect.Effect<A, unknown> =>
      Effect.gen(function* () {
        if (forceRefresh) {
          tokenManager.invalidate();
        }
        const token = yield* fromPromise(() => tokenManager.current());
        const client = createMangaDexClient({
          accessToken: token,
          userAgent: manifoldUserAgent("cli"),
        });
        return yield* invoke(client);
      });

    return yield* attempt(false).pipe(
      Effect.catch((error) => {
        if (isAuthFailure(error)) {
          return attempt(true);
        }
        return Effect.fail(error);
      }),
    );
  });

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

const matchMangaDexEffect = (
  tokenManager: MangaDexTokenManager,
  entry: AniListEntry,
): Effect.Effect<TitleMatch | undefined, unknown> =>
  Effect.gen(function* () {
    const normalized = normalizeTitle(entry.title);

    // Prefer a search result whose links.al carries this exact AniList id —
    // the same direct-hit cascade the reverse migration relies on.
    const results = yield* withMangaDexClient(tokenManager, (client) => client.search(entry.title));
    const directHit = results.find((manga) => manga.anilistId === String(entry.mediaId));
    if (directHit) {
      return { manga: { id: directHit.id, title: directHit.title }, method: "links-al" as const };
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
      yield* sleep(MD_REQUEST_INTERVAL_MS);
      const retry = yield* withMangaDexClient(tokenManager, (client) => client.search(shortened));
      const retryDirect = retry.find((manga) => manga.anilistId === String(entry.mediaId));
      if (retryDirect) {
        return {
          manga: { id: retryDirect.id, title: retryDirect.title },
          method: "links-al" as const,
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
  });

/**
 * Collects the IDs of the lowest-numbered chapters up to and including the
 * given progress value, so marking them read reproduces AniList progress.
 */
const chapterIdsUpToEffect = (
  getChapters: (mangaId: string) => Effect.Effect<readonly MangaDexChapter[], MangaDexSourceError>,
  mangaId: string,
  progress: number,
): Effect.Effect<string[], MangaDexSourceError> =>
  Effect.gen(function* () {
    const chapters = yield* getChapters(mangaId);
    const numbered = chapters
      .filter((chapter) => chapter.chapterNumber !== undefined)
      .sort((a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0));
    const ids: string[] = [];
    for (const chapter of numbered) {
      // SAFETY: value matches number at this call site
      const number = chapter.chapterNumber as number;
      if (number > progress) {
        break;
      }
      ids.push(chapter.id);
    }
    return ids;
  });

/** Promise facade for callers that already hold a Promise-based chapter getter. */
export const chapterIdsUpTo = (
  client: { getChapters: (mangaId: string) => Promise<readonly MangaDexChapter[]> },
  mangaId: string,
  progress: number,
): Promise<string[]> =>
  runHost(
    chapterIdsUpToEffect(
      (id) =>
        fromPromise(() => client.getChapters(id)).pipe(
          Effect.mapError((cause): MangaDexSourceError => ({
            _tag: "MangaDexSourceError",
            message: cause instanceof Error ? cause.message : errorMessage(cause),
          })),
        ),
      mangaId,
      progress,
    ),
  );

/**
 * Runs one migration pass: fetches the AniList manga list, matches every
 * entry to a MangaDex manga (links.al direct hit first, then title search),
 * and applies reading status + chapter-marker backfill on MangaDex.
 *
 * Matching performs live MangaDex searches and is rate-limited; applying is
 * skipped entirely in dry-run mode.
 */
const runMigrationEffect = (
  anilistEntries: readonly AniListEntry[],
  tokenManager: MangaDexTokenManager,
  options: MigrationOptions,
): Effect.Effect<MigrationReport> =>
  Effect.gen(function* () {
    const matched: MatchedEntry[] = [];
    const unmatched: UnmatchedEntry[] = [];

    for (const [index, entry] of anilistEntries.entries()) {
      if (index > 0) {
        yield* sleep(MD_REQUEST_INTERVAL_MS);
      }
      const mangadexStatus = mangaDexStatusFor(entry.status);

      const outcome = yield* Effect.gen(function* () {
        const match = yield* matchMangaDexEffect(tokenManager, entry);
        if (!match) {
          unmatched.push({
            mediaId: entry.mediaId,
            title: entry.title,
            anilistStatus: entry.status,
            ...(entry.progress !== undefined && { progress: entry.progress }),
            reason: "No MangaDex candidate matched",
          });
          return;
        }

        let chaptersToMark = 0;
        if (options.includeProgress && entry.progress !== undefined && entry.progress >= 1) {
          yield* sleep(MD_REQUEST_INTERVAL_MS);
          const chapterIds = yield* withMangaDexClient(tokenManager, (client) =>
            chapterIdsUpToEffect((id) => client.getChapters(id), match.manga.id, entry.progress!),
          );
          chaptersToMark = chapterIds.length;
          if (!options.dryRun && chapterIds.length > 0) {
            yield* withMangaDexClient(tokenManager, (client) =>
              client.markChaptersRead(match.manga.id, chapterIds),
            );
          }
        }

        if (!options.dryRun && mangadexStatus) {
          yield* sleep(MD_REQUEST_INTERVAL_MS);
          yield* withMangaDexClient(tokenManager, (client) =>
            client.updateReadingStatus(match.manga.id, mangadexStatus),
          );
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
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
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
              error:
                cause instanceof Error ? cause.message : `Unknown failure: ${errorMessage(cause)}`,
            });
          }),
        ),
      );
      void outcome;
    }

    return {
      scanned: anilistEntries.length,
      matched,
      unmatched,
      dryRun: options.dryRun,
    };
  });

export const runMigration = (
  anilistEntries: readonly AniListEntry[],
  tokenManager: MangaDexTokenManager,
  options: MigrationOptions,
): Promise<MigrationReport> => runHost(runMigrationEffect(anilistEntries, tokenManager, options));
