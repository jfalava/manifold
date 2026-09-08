import * as Effect from "effect/Effect";
import { manifoldUserAgent } from "@manifold/json";
import type { CanonicalSearchProviderFilter, RegistryEntry } from "@manifold/contract";
import {
  createAniListSource,
  createMyAnimeListSource,
  type CanonicalFetcher,
} from "@manifold/canonical/sources";
import type {
  CanonicalEntry,
  CanonicalSearchResult,
  CanonicalSearchSource,
  CanonicalSourceError,
} from "@manifold/canonical";
import type { Env } from "./types";

export type CanonicalProviderFilter = CanonicalSearchProviderFilter;

export interface CanonicalProviderSearch {
  readonly provider: CanonicalSearchSource["provider"];
  readonly results: readonly CanonicalSearchResult[];
  readonly error?: {
    readonly message: string;
    readonly status?: number;
  };
}

export interface CanonicalSearchResponse {
  readonly query: string;
  readonly results: readonly CanonicalSearchResult[];
  readonly providers: readonly CanonicalProviderSearch[];
}

const searchSource = async (
  source: CanonicalSearchSource,
  query: string,
  limit: number,
): Promise<CanonicalProviderSearch> =>
  Effect.runPromise(source.search(query, { limit }).pipe(Effect.match({
    onSuccess: (results): CanonicalProviderSearch => ({
      provider: source.provider,
      results,
    }),
    onFailure: (failure): CanonicalProviderSearch => ({
      provider: source.provider,
      results: [],
      error: {
        message: failure.message,
        ...(failure.status !== undefined && { status: failure.status }),
      },
    }),
  })));

const isUnavailable = (error: { readonly status?: number }): boolean =>
  error.status === undefined || [401, 403, 408, 429].includes(error.status) || error.status >= 500;

const selectedSources = (
  env: Env,
  provider: CanonicalProviderFilter,
): readonly CanonicalSearchSource[] => {
  const sources: CanonicalSearchSource[] = [];
  const userAgent = manifoldUserAgent("api");
  const fetcher: CanonicalFetcher = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(5_000) });
  if (provider === "all" || provider === "anilist") {
    sources.push(createAniListSource({ userAgent, fetcher }));
  }
  if (provider === "all" || provider === "mal") {
    sources.push(createMyAnimeListSource({
      clientId: env.MANIFOLD_MAL_CLIENT_ID,
      userAgent,
      fetcher,
    }));
  }
  return sources;
};

export const searchCanonical = async (
  env: Env,
  query: string,
  provider: CanonicalProviderFilter,
  limit: number,
): Promise<CanonicalSearchResponse> => {
  const providers: CanonicalProviderSearch[] = [];
  if (provider === "auto") {
    for (const source of selectedSources(env, "all")) {
      const result = await searchSource(source, query, limit);
      providers.push(result);
      if (!result.error || !isUnavailable(result.error)) {break;}
    }
  } else {
    providers.push(...await Promise.all(
      selectedSources(env, provider).map((source) => searchSource(source, query, limit)),
    ));
  }
  return {
    query,
    providers,
    results: providers.flatMap((result) => result.results),
  };
};

export const getCanonical = async (
  env: Env,
  provider: CanonicalSearchSource["provider"],
  providerId: string,
): Promise<CanonicalEntry | undefined> => {
  const source = selectedSources(env, provider)[0];
  if (!source) {return undefined;}
  return Effect.runPromise(source.getById(providerId));
};

/** Hydrate only recorded identities. An outage must never change a registry UUID. */
export const getRegistryCanonical = async (
  env: Env,
  entry: RegistryEntry,
): Promise<CanonicalEntry> => {
  for (const source of selectedSources(env, "all")) {
    const link = entry.providers.find((item) => item.provider === source.provider);
    if (!link) {continue;}
    const outcome = await Effect.runPromise(source.getById(link.externalId).pipe(Effect.match({
      onSuccess: (value) => ({ value, error: undefined }),
      onFailure: (error: CanonicalSourceError) => ({ value: undefined, error }),
    })));
    if (outcome.value) {return { ...outcome.value, id: entry.id };}
    if (outcome.error) {
      console.warn(JSON.stringify({
        event: "canonical.details.failed", entryId: entry.id, ...outcome.error,
      }));
      if (!isUnavailable(outcome.error) && outcome.error.status !== 404) {break;}
    }
  }
  return {
    id: entry.id,
    provider: entry.provider,
    providerId: entry.providerId,
    title: entry.title,
    aliases: [],
  };
};
