import * as Effect from "effect/Effect";
import { isJsonObject, manifoldUserAgent, numberField, stringField } from "@manifold/json";
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
  cause: unknown,
): CanonicalSourceError => {
  if (isJsonObject(cause) && cause._tag === "CanonicalSourceError") {
    const taggedProvider = stringField(cause, "provider");
    const message = stringField(cause, "message");
    if (
      (taggedProvider === "anilist" || taggedProvider === "mal") &&
      message !== undefined
    ) {
      const status = numberField(cause, "status");
      return {
        _tag: "CanonicalSourceError",
        provider: taggedProvider,
        message,
        ...(!(status === undefined) && { status }),
      };
    }
  }
  return {
    _tag: "CanonicalSourceError",
    provider,
    message: cause instanceof Error ? cause.message : "Canonical provider search failed",
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
        ...(!(failure.status === undefined) && { status: failure.status }),
      },
    };
  }
};

const selectedSources = (
  env: Env,
  provider: CanonicalProviderFilter,
): readonly CanonicalSearchSource[] => {
  const sources: CanonicalSearchSource[] = [];
  const userAgent = manifoldUserAgent("api");
  if (provider === "all" || provider === "anilist") {
    sources.push(createAniListSource({ userAgent }));
  }
  if (provider === "all" || provider === "mal") {
    sources.push(createMyAnimeListSource({
      clientId: env.MANIFOLD_MAL_CLIENT_ID,
      userAgent,
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
