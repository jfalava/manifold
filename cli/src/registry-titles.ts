import { Effect } from "effect";
import { fetchAniListTitles } from "./anilist";
import { uniqueTitles } from "./title-normalization";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import { createMangaDexClient } from "@manifold/mangadex";
import { cliError, platformFetch, runHost } from "@/effect-kit";

export const MAX_SEARCH_TERMS = 3;

export const searchTitlesFor = (titles: readonly string[]): readonly string[] =>
  uniqueTitles(titles).slice(0, MAX_SEARCH_TERMS);

export const providerIdOf = (
  row: {
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  provider: string,
): string | undefined => row.providers.find((link) => link.provider === provider)?.externalId;

/**
 * Collect every language/title variant for registry prefill matching.
 * AniList english/romaji/native/synonyms first; MangaDex alts only when the
 * row already has a mangadex link and AniList did not add a second name.
 * Shared by registry provider prefills.
 */
const loadRegistrySearchTitlesEffect = (
  row: {
    readonly title: string;
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  options: {
    readonly anilistToken?: string;
    readonly anilistTitles?: (
      token: string,
      mediaId: number,
      signal: AbortSignal,
    ) => Promise<readonly string[]>;
    readonly mangaDexTitles?: (id: string, signal: AbortSignal) => Promise<readonly string[]>;
    readonly onProgress?: (message: string) => void;
    readonly onIncomplete?: () => void;
  } = {},
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const titles = [row.title];
    const anilistId = providerIdOf(row, "anilist");
    if (anilistId && options.anilistToken) {
      const parsed = Number(anilistId);
      if (Number.isInteger(parsed) && parsed > 0) {
        options.onProgress?.("Loading AniList aliases (20s timeout)");
        yield* Effect.tryPromise({
          try: (signal) =>
            (options.anilistTitles ?? fetchAniListTitles)(options.anilistToken!, parsed, signal),
          catch: (cause) => cliError(errorMessage(cause)),
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.map((extra) => {
            titles.push(...extra);
          }),
          Effect.catch(() =>
            Effect.sync(() => {
              options.onIncomplete?.();
              options.onProgress?.(
                "AniList aliases unavailable or timed out; continuing with known titles",
              );
            }),
          ),
        );
      }
    }
    const unique = uniqueTitles(titles);
    if (unique.length >= 2) {
      return unique;
    }
    const mangadexId = providerIdOf(row, "mangadex");
    if (!mangadexId) {
      return unique;
    }
    options.onProgress?.("Loading MangaDex aliases (20s timeout)");
    return yield* Effect.gen(function* () {
      const signal = yield* Effect.abortSignal;
      if (options.mangaDexTitles) {
        return yield* Effect.tryPromise({
          try: () => options.mangaDexTitles!(mangadexId, signal),
          catch: (cause) => cliError(errorMessage(cause)),
        });
      }
      const manga = yield* createMangaDexClient({
        userAgent: manifoldUserAgent("cli"),
        fetcher: (input, init) => platformFetch(input, { ...init, signal }),
      }).getManga(mangadexId);
      return [manga.title, ...manga.altTitles] as const;
    }).pipe(
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.map((extra) => uniqueTitles([...unique, ...extra])),
      Effect.orElseSucceed(() => {
        options.onIncomplete?.();
        options.onProgress?.(
          "MangaDex aliases unavailable or timed out; continuing with known titles",
        );
        return unique;
      }),
    );
  });

export const loadRegistrySearchTitles = (
  row: {
    readonly title: string;
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  options: {
    readonly anilistToken?: string;
    readonly anilistTitles?: (
      token: string,
      mediaId: number,
      signal: AbortSignal,
    ) => Promise<readonly string[]>;
    readonly mangaDexTitles?: (id: string, signal: AbortSignal) => Promise<readonly string[]>;
    readonly onProgress?: (message: string) => void;
    readonly onIncomplete?: () => void;
  } = {},
): Promise<readonly string[]> => runHost(loadRegistrySearchTitlesEffect(row, options));
