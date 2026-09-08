import { Effect } from "effect";
import { fetchAniListTitles } from "./anilist";
import { uniqueTitles } from "./comix-match";
import { manifoldUserAgent } from "@manifold/json";
import { createMangaDexClient } from "@manifold/mangadex";

export const MAX_COMIX_SEARCH_TERMS = 3;

export const searchTitlesFor = (titles: readonly string[]): readonly string[] =>
  uniqueTitles(titles).slice(0, MAX_COMIX_SEARCH_TERMS);

export const providerIdOf = (
  row: {
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  provider: string,
): string | undefined =>
  row.providers.find((link) => link.provider === provider)?.externalId;

/**
 * Collect every language/title variant for registry prefill matching.
 * AniList english/romaji/native/synonyms first; MangaDex alts only when the
 * row already has a mangadex link and AniList did not add a second name.
 * Used by both Comix (browse) and MangaDex (Worker resolve) prefills.
 */
export const loadRegistrySearchTitles = async (
  row: {
    readonly title: string;
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  options: {
    readonly anilistToken?: string;
    readonly anilistTitles?: (
      token: string,
      mediaId: number,
    ) => Promise<readonly string[]>;
    readonly mangaDexTitles?: (id: string) => Promise<readonly string[]>;
  } = {},
): Promise<readonly string[]> => {
  const titles = [row.title];
  const anilistId = providerIdOf(row, "anilist");
  if (anilistId && options.anilistToken) {
    const parsed = Number(anilistId);
    if (Number.isInteger(parsed) && parsed > 0) {
      try {
        const loadAniList = options.anilistTitles ?? fetchAniListTitles;
        titles.push(...(await loadAniList(options.anilistToken, parsed)));
      } catch {
        // keep the registry title if AniList is down
      }
    }
  }
  const unique = uniqueTitles(titles);
  if (unique.length >= 2) {return unique;}
  const mangadexId = providerIdOf(row, "mangadex");
  if (!mangadexId) {return unique;}
  const loadMangaDex = options.mangaDexTitles ?? (async (id: string) => {
    const manga = await Effect.runPromise(
      createMangaDexClient({ userAgent: manifoldUserAgent("cli") }).getManga(id),
    );
    return [manga.title, ...manga.altTitles];
  });
  try {
    return uniqueTitles([...unique, ...(await loadMangaDex(mangadexId))]);
  } catch {
    return unique;
  }
};
