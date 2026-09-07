import type { CanonicalSearchResult } from "@manifold/canonical";
import type { PersonalEntry } from "@manifold/paperback-runtime";

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const matchRank = (
  query: string,
  titles: readonly string[],
): number | undefined => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {return undefined;}
  const queryTokens = normalizedQuery.split(" ");
  let best: number | undefined;
  for (const title of titles) {
    const normalizedTitle = normalizeSearchText(title);
    if (!normalizedTitle) {continue;}
    const rank = normalizedTitle === normalizedQuery
      ? 0
      : normalizedTitle.startsWith(normalizedQuery)
        ? 1
        : normalizedTitle.includes(normalizedQuery)
          ? 2
          : queryTokens.every((token) => normalizedTitle.includes(token))
            ? 3
            : undefined;
    if (rank !== undefined && (best === undefined || rank < best)) {best = rank;}
  }
  return best;
};

export const filterAndRankAniListResults = (
  query: string,
  results: readonly CanonicalSearchResult[],
): CanonicalSearchResult[] =>
  results
    .flatMap((result, index) => {
      const rank = matchRank(query, [result.title, ...result.aliases]);
      return rank === undefined ? [] : [{ result, rank, index }];
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ result }) => result);

export const filterAndRankRegistryEntries = (
  query: string,
  entries: readonly PersonalEntry[],
): PersonalEntry[] =>
  entries
    .flatMap((entry, index) => {
      const rank = matchRank(query, [
        entry.title,
        ...entry.providers.flatMap((provider) => provider.title ?? []),
      ]);
      return rank === undefined ? [] : [{ entry, rank, index }];
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ entry }) => entry);
