import { ContentRating, type SearchResultItem } from "@paperback/types";
import type { IngestCandidateInput, RegistryProvider } from "@manifold/contract";
import type { CanonicalSearchResult } from "@manifold/canonical";
import { safeImageUrl } from "./image-url.js";

const CANDIDATE_PREFIX = "provider-candidate:";

export type ProviderSearchScope = "all" | "registry" | "anilist" | "mangadex" | "comix";

export interface ProviderSearchInput {
  readonly query: string;
  readonly scope: ProviderSearchScope;
}

export const parseProviderSearchInput = (
  value: string,
): ProviderSearchInput => {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) {return { query: trimmed, scope: "all" };}
  const prefix = trimmed.slice(0, separator).toLocaleLowerCase();
  const query = trimmed.slice(separator + 1).trim();
  const scope = prefix === "registry" ? "registry" :
    prefix === "anilist" || prefix === "al" ? "anilist" :
    prefix === "mangadex" || prefix === "md" ? "mangadex" :
    prefix === "comix" ? "comix" : undefined;
  return scope && query ? { query, scope } : { query: trimmed, scope: "all" };
};

const isRegistryProvider = (value: string): value is RegistryProvider =>
  value === "anilist" || value === "mal" || value === "mangadex" || value === "comix";

export interface ProviderCandidate {
  readonly provider: RegistryProvider;
  readonly providerId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly imageUrl: string;
  readonly links?: IngestCandidateInput["links"];
  readonly description?: string;
}

export interface MangaDexCandidateInput {
  readonly id: string;
  readonly title: string;
  readonly altTitles: readonly string[];
  readonly anilistId?: string;
  readonly myAnimeListId?: string;
  readonly description?: string;
  readonly coverUrl?: string;
}

export const aniListProviderCandidate = (
  result: CanonicalSearchResult,
): ProviderCandidate => ({
  provider: "anilist",
  providerId: result.providerId,
  title: result.title,
  aliases: result.aliases,
  imageUrl: safeImageUrl(result.metadata?.coverUrl),
  description: result.metadata?.description,
  links: [
    ...(result.externalIds?.mal
      ? [{ provider: "mal" as const, externalId: result.externalIds.mal }]
      : []),
    ...(result.externalIds?.mangadex
      ? [{ provider: "mangadex" as const, externalId: result.externalIds.mangadex }]
      : []),
  ],
});

export const mangaDexProviderCandidate = (
  manga: MangaDexCandidateInput,
): ProviderCandidate => ({
  provider: "mangadex",
  providerId: manga.id,
  title: manga.title,
  aliases: manga.altTitles,
  imageUrl: safeImageUrl(manga.coverUrl),
  description: manga.description,
  links: [
    ...(manga.anilistId
      ? [{ provider: "anilist" as const, externalId: manga.anilistId }]
      : []),
    ...(manga.myAnimeListId
      ? [{ provider: "mal" as const, externalId: manga.myAnimeListId }]
      : []),
  ],
});

/** Add MangaDex IDs to AniList hits only when MangaDex supplied that exact AniList cross-link. */
export const correlateProviderCandidates = (
  candidates: readonly ProviderCandidate[],
): ProviderCandidate[] => {
  const mangaDexByAniList = new Map<string, ProviderCandidate | null>();
  for (const candidate of candidates) {
    if (candidate.provider !== "mangadex") {continue;}
    const anilistId = candidate.links?.find((link) => link.provider === "anilist")?.externalId;
    if (!anilistId) {continue;}
    mangaDexByAniList.set(anilistId, mangaDexByAniList.has(anilistId) ? null : candidate);
  }
  return candidates.map((candidate) => {
    if (candidate.provider !== "anilist") {return candidate;}
    const mangaDex = mangaDexByAniList.get(candidate.providerId);
    if (!mangaDex || candidate.links?.some((link) => link.provider === "mangadex")) {
      return candidate;
    }
    return {
      ...candidate,
      links: [
        ...(candidate.links ?? []),
        { provider: "mangadex", externalId: mangaDex.providerId, title: mangaDex.title },
      ],
    };
  });
};

export const providerCandidateId = (
  provider: RegistryProvider,
  providerId: string,
): string => `${CANDIDATE_PREFIX}${provider}:${encodeURIComponent(providerId)}`;

export const parseProviderCandidateId = (
  value: string,
): { readonly provider: RegistryProvider; readonly providerId: string } | undefined => {
  if (!value.startsWith(CANDIDATE_PREFIX)) {return undefined;}
  const rest = value.slice(CANDIDATE_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) {return undefined;}
  const provider = rest.slice(0, separator);
  if (!isRegistryProvider(provider)) {return undefined;}
  const encodedId = rest.slice(separator + 1);
  if (!encodedId) {return undefined;}
  try {
    const providerId = decodeURIComponent(encodedId);
    return providerId
      ? { provider, providerId }
      : undefined;
  } catch {
    return undefined;
  }
};

export const toProviderCandidateSearchResult = (
  candidate: ProviderCandidate,
): SearchResultItem => ({
  mangaId: providerCandidateId(candidate.provider, candidate.providerId),
  title: candidate.title,
  subtitle: [candidate.provider === "mangadex" ? "MangaDex" :
    candidate.provider === "comix" ? "Comix" :
    candidate.provider === "anilist" ? "AniList" : "MyAnimeList", ...candidate.aliases]
    .filter(Boolean)
    .join(" · "),
  imageUrl: safeImageUrl(candidate.imageUrl),
  contentRating: ContentRating.MATURE,
  metadata: candidate,
});
