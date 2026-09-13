import { hostLogWarn, platformFetch } from "./effect-host";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
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

const JsonString = Schema.fromJsonString(Schema.Unknown);

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

const searchSource = (
  source: CanonicalSearchSource,
  query: string,
  limit: number,
): Effect.Effect<CanonicalProviderSearch> =>
  source.search(query, { limit }).pipe(
    Effect.match({
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
    }),
  );

const isUnavailable = (error: { readonly status?: number }): boolean =>
  error.status === undefined || [401, 403, 408, 429].includes(error.status) || error.status >= 500;

const selectedSources = (
  env: Env,
  provider: CanonicalProviderFilter,
): readonly CanonicalSearchSource[] => {
  const sources: CanonicalSearchSource[] = [];
  const userAgent = manifoldUserAgent("api");
  const fetcher: CanonicalFetcher = (input, init) =>
    platformFetch(input, { ...init, signal: AbortSignal.timeout(5_000) });
  if (provider === "all" || provider === "anilist") {
    sources.push(createAniListSource({ userAgent, fetcher }));
  }
  if (provider === "all" || provider === "mal") {
    sources.push(
      createMyAnimeListSource({
        clientId: env.MANIFOLD_MAL_CLIENT_ID,
        userAgent,
        fetcher,
      }),
    );
  }
  return sources;
};

export const searchCanonical = (
  env: Env,
  query: string,
  provider: CanonicalProviderFilter,
  limit: number,
): Promise<CanonicalSearchResponse> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const providers: CanonicalProviderSearch[] = [];
      if (provider === "auto") {
        for (const source of selectedSources(env, "all")) {
          const result = yield* searchSource(source, query, limit);
          providers.push(result);
          if (!result.error || !isUnavailable(result.error)) {
            break;
          }
        }
      } else {
        providers.push(
          ...(yield* Effect.forEach(
            selectedSources(env, provider),
            (source) => searchSource(source, query, limit),
            { concurrency: "unbounded" },
          )),
        );
      }
      return {
        query,
        providers,
        results: providers.flatMap((result) => result.results),
      };
    }),
  );

export const getCanonical = (
  env: Env,
  provider: CanonicalSearchSource["provider"],
  providerId: string,
): Promise<CanonicalEntry | undefined> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const source = selectedSources(env, provider)[0];
      if (!source) {
        return undefined;
      }
      return yield* source.getById(providerId);
    }),
  );

/** Hydrate only recorded identities. An outage must never change a registry UUID. */
export const getRegistryCanonical = (env: Env, entry: RegistryEntry): Promise<CanonicalEntry> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const source of selectedSources(env, "all")) {
        const link = entry.providers.find((item) => item.provider === source.provider);
        if (!link) {
          continue;
        }
        const outcome = yield* source.getById(link.externalId).pipe(
          Effect.match({
            onSuccess: (value) => ({ value, error: undefined }),
            onFailure: (error: CanonicalSourceError) => ({ value: undefined, error }),
          }),
        );
        if (outcome.value) {
          return { ...outcome.value, id: entry.id };
        }
        if (outcome.error) {
          const details = yield* Schema.encodeEffect(JsonString)({
            event: "canonical.details.failed",
            entryId: entry.id,
            ...outcome.error,
          });
          hostLogWarn(details);
          if (!isUnavailable(outcome.error) && outcome.error.status !== 404) {
            break;
          }
        }
      }
      return {
        id: entry.id,
        provider: entry.provider,
        providerId: entry.providerId,
        title: entry.title,
        aliases: [],
      };
    }),
  );
