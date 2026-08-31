import * as Effect from "effect/Effect";
import {
  createAniListSource,
  createMyAnimeListSource,
} from "@manifold/canonical/sources";
import type {
  CanonicalEntry,
  CanonicalSearchResult,
  CanonicalSearchSource,
  CanonicalSourceError,
} from "@manifold/canonical";
import type { Env } from "./types";

export type CanonicalProviderFilter = "all" | "anilist" | "mal";

export interface CanonicalProviderSearch {
  readonly provider: Exclude<CanonicalProviderFilter, "all">;
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

const sourceError = (
  provider: CanonicalSourceError["provider"],
  error: unknown,
): CanonicalSourceError => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "CanonicalSourceError" &&
    "provider" in error &&
    (error.provider === "anilist" || error.provider === "mal") &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error as CanonicalSourceError;
  }
  return {
    _tag: "CanonicalSourceError",
    provider,
    message: error instanceof Error ? error.message : "Canonical provider search failed",
  };
};

const searchSource = async (
  source: CanonicalSearchSource,
  query: string,
  limit: number,
): Promise<CanonicalProviderSearch> => {
  try {
    return {
      provider: source.provider,
      results: await Effect.runPromise(source.search(query, { limit })),
    };
  } catch (error) {
    const failure = sourceError(source.provider, error);
    return {
      provider: source.provider,
      results: [],
      error: {
        message: failure.message,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      },
    };
  }
};

const selectedSources = (
  env: Env,
  provider: CanonicalProviderFilter,
): readonly CanonicalSearchSource[] => {
  const sources: CanonicalSearchSource[] = [];
  if (provider === "all" || provider === "anilist") {sources.push(createAniListSource());}
  if (provider === "all" || provider === "mal") {
    sources.push(createMyAnimeListSource({ clientId: env.MAL_CLIENT_ID }));
  }
  return sources;
};

export const searchCanonical = async (
  env: Env,
  query: string,
  provider: CanonicalProviderFilter,
  limit: number,
): Promise<CanonicalSearchResponse> => {
  const providers = await Promise.all(
    selectedSources(env, provider).map((source) => searchSource(source, query, limit)),
  );
  return {
    query,
    providers,
    results: providers.flatMap((result) => result.results),
  };
};

export const getCanonical = async (
  env: Env,
  provider: Exclude<CanonicalProviderFilter, "all">,
  providerId: string,
): Promise<CanonicalEntry | undefined> => {
  const source = selectedSources(env, provider)[0];
  if (!source) {return undefined;}
  return Effect.runPromise(source.getById(providerId));
};
