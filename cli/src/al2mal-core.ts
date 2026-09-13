import {
  errorMessage,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  numberField,
  objectField,
  stringField,
} from "@manifold/json";
import { MYANIMELIST_MANGA_ENDPOINT } from "@manifold/canonical/sources";
import { Effect } from "effect";

import type { AniListEntry } from "@/anilist";
import type { MalClient, MalMangaUpdate } from "@/mal";
import { normalizeTitle } from "@/migration";
import {
  cliError,
  epochMillisNow,
  fromPromise,
  runHost,
  sleepPromise,
  type CliEffectError,
} from "@/effect-kit";

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
  if (!isAniListMalStatus(entry.status)) {
    return undefined;
  }
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

export type Al2malSearch = (query: string) => Promise<readonly Al2malSearchHit[]>;

/**
 * MAL GET /manga `q`: 3–64 Unicode code points. Shorter or longer → HTTP 400
 * `invalid q`. Count code points so CJK titles are measured correctly.
 */
export const MAL_SEARCH_Q_MIN = 3;
export const MAL_SEARCH_Q_MAX = 64;

export const malSearchQueryOk = (query: string): boolean => {
  const length = Array.from(query.trim()).length;
  return length >= MAL_SEARCH_Q_MIN && length <= MAL_SEARCH_Q_MAX;
};

/** Clamp to MAL's accepted `q` window; empty when nothing usable remains. */
export const malSearchQuery = (query: string): string | undefined => {
  const trimmed = query.trim();
  const chars = Array.from(trimmed);
  if (chars.length < MAL_SEARCH_Q_MIN) {
    return undefined;
  }
  return chars.length <= MAL_SEARCH_Q_MAX ? trimmed : chars.slice(0, MAL_SEARCH_Q_MAX).join("");
};

/** Same floor as createMalClient (~40 req/min); MAL publishes no hard quota. */
export const MAL_SEARCH_INTERVAL_MS = 1_500;

/**
 * Public-client MAL title search (no user OAuth). Talks to MAL directly so a
 * 400 does not print `[Canonical:mal] …` on a new line and break the progress bar.
 * Sequential calls are spaced like the OAuth list client (1.5s after the first).
 */
export const createMalTitleSearch = (
  clientId: string,
  fetcher: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = sleepPromise,
): Al2malSearch => {
  if (!clientId || clientId === "not-configured") {
    return () => runHost(Effect.fail(cliError("MyAnimeList client id is not configured")));
  }
  let requested = false;
  const searchEffect = (query: string): Effect.Effect<readonly Al2malSearchHit[], CliEffectError> =>
    Effect.gen(function* () {
      const q = malSearchQuery(query);
      if (!q) {
        return [];
      }
      if (requested) {
        yield* fromPromise(() => sleepFn(MAL_SEARCH_INTERVAL_MS)).pipe(
          Effect.mapError((cause) => cliError(errorMessage(cause))),
        );
      }
      requested = true;
      const href =
        `${MYANIMELIST_MANGA_ENDPOINT}?q=${encodeURIComponent(q)}` +
        `&limit=10&fields=${encodeURIComponent("alternative_titles")}`;
      for (let attempt = 0; ; attempt += 1) {
        const response = yield* fromPromise(() =>
          fetcher(href, {
            headers: {
              accept: "application/json",
              "X-MAL-CLIENT-ID": clientId,
              "user-agent": manifoldUserAgent("cli"),
            },
            signal: AbortSignal.timeout(15_000),
          }),
        ).pipe(Effect.mapError((cause) => cliError(errorMessage(cause))));
        if ((response.status === 429 || response.status >= 500) && attempt < 3) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const wait =
            retryAfter === null
              ? NaN
              : Number.isFinite(seconds)
                ? seconds * 1000
                : Date.parse(retryAfter) - epochMillisNow();
          yield* fromPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(
            Effect.ignore,
          );
          if (wait > 300_000) {
            return yield* cliError(
              "MAL title search requested a long retry delay. Stop and resume later.",
            );
          }
          yield* fromPromise(() =>
            sleepFn(
              Number.isFinite(wait) ? Math.max(MAL_SEARCH_INTERVAL_MS, wait) : 5000 * 2 ** attempt,
            ),
          ).pipe(Effect.mapError((cause) => cliError(errorMessage(cause))));
          continue;
        }
        if (!response.ok) {
          const body = (yield* fromPromise(() => response.text().catch(() => "")).pipe(
            Effect.mapError((cause) => cliError(errorMessage(cause))),
          ))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
          return yield* cliError(
            `MAL title search HTTP ${response.status}${body ? `: ${body}` : ""}`,
          );
        }
        const json: unknown = yield* fromPromise(() => response.json()).pipe(
          Effect.mapError((cause) => cliError(errorMessage(cause))),
        );
        if (!isJsonObject(json)) {
          return [];
        }
        const data = isJsonArray(json.data) ? json.data : [];
        const hits: Al2malSearchHit[] = [];
        for (const item of data) {
          if (!isJsonObject(item)) {
            continue;
          }
          const node = objectField(item, "node") ?? item;
          const id = numberField(node, "id");
          const title = stringField(node, "title");
          if (id === undefined || id <= 0 || title === undefined) {
            continue;
          }
          const alternative = objectField(node, "alternative_titles");
          const aliases = [
            alternative === undefined ? undefined : stringField(alternative, "en"),
            alternative === undefined ? undefined : stringField(alternative, "ja"),
            ...(alternative !== undefined && isJsonArray(alternative.synonyms)
              ? alternative.synonyms.filter(isString)
              : []),
          ].filter((value): value is string => value !== undefined && value.trim().length > 0);
          hits.push({ id, title, aliases });
        }
        return hits;
      }
    });
  return (query) => runHost(searchEffect(query));
};

const titlePool = (entry: AniListEntry): string[] => {
  const values = new Map<string, string>();
  for (const title of [entry.title, ...(entry.titles ?? [])]) {
    const trimmed = title.trim();
    // Keep short titles for exact compare against MAL hit aliases, but never
    // send them as MAL search `q` (see malSearchQueryOk).
    const key = normalizeTitle(trimmed);
    if (key && !values.has(key)) {
      values.set(key, trimmed);
    }
  }
  return [...values.values()];
};

const chooseTitleMatch = (
  entry: AniListEntry,
  hits: readonly Al2malSearchHit[],
): { hit: Al2malSearchHit; method: "title-exact" | "title-partial" } | undefined => {
  const wanted = new Set(titlePool(entry).map(normalizeTitle));
  if (wanted.size === 0 || hits.length === 0) {
    return undefined;
  }

  const exact = hits.filter((hit) =>
    [hit.title, ...hit.aliases].some((title) => wanted.has(normalizeTitle(title))),
  );
  if (exact.length === 1) {
    return { hit: exact[0]!, method: "title-exact" };
  }
  if (exact.length > 1) {
    return undefined;
  }

  // Single partial: one hit whose normalized title starts with / is started by a candidate.
  const partial = hits.filter((hit) => {
    const names = [hit.title, ...hit.aliases].map(normalizeTitle).filter(Boolean);
    return names.some((name) =>
      [...wanted].some((want) => name.startsWith(want) || want.startsWith(name)),
    );
  });
  if (partial.length === 1) {
    return { hit: partial[0]!, method: "title-partial" };
  }
  return undefined;
};

const matchAniListToMalEffect = (
  entry: AniListEntry,
  search: Al2malSearch,
  options: { readonly includeProgress: boolean },
): Effect.Effect<
  { kind: "matched"; value: Al2malMatched } | { kind: "unmatched"; value: Al2malUnmatched }
> =>
  Effect.gen(function* () {
    const update = malUpdateForAniList(entry, options);
    if (!update) {
      return {
        kind: "unmatched" as const,
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
        kind: "matched" as const,
        value: {
          mediaId: entry.mediaId,
          title: entry.title,
          anilistStatus: entry.status,
          malId: Number(entry.malId),
          matchedTitle: entry.title,
          method: "idMal" as const,
          update,
        },
      };
    }

    const candidates = new Map<number, Al2malSearchHit>();
    let searchError: string | undefined;
    const queries = [
      ...new Set(
        titlePool(entry)
          .map(malSearchQuery)
          .filter((value): value is string => value !== undefined),
      ),
    ];
    for (const title of queries) {
      yield* fromPromise(() => search(title)).pipe(
        Effect.map((hits) => {
          for (const hit of hits) {
            candidates.set(hit.id, hit);
          }
        }),
        Effect.catch((cause) =>
          Effect.sync(() => {
            // One bad title must not abort the whole library import or spam stdout.
            searchError = errorMessage(cause);
          }),
        ),
      );
    }
    const chosen = chooseTitleMatch(entry, [...candidates.values()]);
    if (!chosen) {
      return {
        kind: "unmatched" as const,
        value: {
          mediaId: entry.mediaId,
          title: entry.title,
          anilistStatus: entry.status,
          ...(entry.progress !== undefined && { progress: entry.progress }),
          reason: searchError
            ? `MAL title search failed: ${searchError}`
            : queries.length === 0
              ? `No title usable for MAL search (q needs ${MAL_SEARCH_Q_MIN}–${MAL_SEARCH_Q_MAX} characters) and no idMal`
              : candidates.size === 0
                ? "No MAL candidates for title search"
                : "Ambiguous or weak MAL title match",
        },
      };
    }

    return {
      kind: "matched" as const,
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
  });

export const matchAniListToMal = (
  entry: AniListEntry,
  search: Al2malSearch,
  options: { readonly includeProgress: boolean },
): Promise<
  { kind: "matched"; value: Al2malMatched } | { kind: "unmatched"; value: Al2malUnmatched }
> => runHost(matchAniListToMalEffect(entry, search, options));

/**
 * Match every AniList manga entry to MAL, then optionally PATCH list status
 * (and chapter progress). Dry-run never writes. Failures are recorded per entry
 * so a rerun can resume after fixing tokens or rate limits.
 */
const runAl2malEffect = (options: {
  readonly entries: readonly AniListEntry[];
  readonly search: Al2malSearch;
  readonly client: Pick<MalClient, "updateManga">;
  readonly dryRun: boolean;
  readonly includeProgress: boolean;
  readonly onMatched?: (entry: Al2malMatched, index: number, total: number) => void;
  readonly onUnmatched?: (entry: Al2malUnmatched, index: number, total: number) => void;
  readonly onWritten?: (done: number, total: number) => void;
}): Effect.Effect<Al2malReport> =>
  Effect.gen(function* () {
    const matched: Al2malMatched[] = [];
    const unmatched: Al2malUnmatched[] = [];

    for (const [index, entry] of options.entries.entries()) {
      const result = yield* matchAniListToMalEffect(entry, options.search, {
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
        yield* fromPromise(() => options.client.updateManga(entry.malId, entry.update)).pipe(
          Effect.map(() => {
            written += 1;
          }),
          Effect.catch((cause) =>
            Effect.sync(() => {
              failed += 1;
              entry.error = errorMessage(cause);
            }),
          ),
        );
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
  });

export const runAl2mal = (options: {
  readonly entries: readonly AniListEntry[];
  readonly search: Al2malSearch;
  readonly client: Pick<MalClient, "updateManga">;
  readonly dryRun: boolean;
  readonly includeProgress: boolean;
  readonly onMatched?: (entry: Al2malMatched, index: number, total: number) => void;
  readonly onUnmatched?: (entry: Al2malUnmatched, index: number, total: number) => void;
  readonly onWritten?: (done: number, total: number) => void;
}): Promise<Al2malReport> => runHost(runAl2malEffect(options));
