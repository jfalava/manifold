import { Effect, Schema } from "effect";
import {
  CanonicalIdentity,
  CanonicalSearchResponse,
  EntryByProviderResponse,
  ErrorBody,
  MangaDexMatchInput,
  MangaDexMatchResult,
  RegistryEntriesResponse,
  RegistryEntry,
  ResolveEntryInput,
} from "@manifold/contract";
import { isJsonArray } from "@manifold/json";
import { getCanonical, searchCanonical, type CanonicalProviderFilter } from "../canonical";
import {
  attempt,
  jsonEncoded,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";
import { resolveMangaDex } from "../mangadex-match";

const canonicalProvider = (value: string | null): CanonicalProviderFilter | undefined => {
  if (value === null || value === "all") {return "all";}
  if (value === "anilist" || value === "mal") {return value;}
  return undefined;
};

const searchLimit = (value: string | null): number => {
  const parsed = value === null ? 20 : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {return 20;}
  return Math.min(25, Math.max(1, parsed));
};

export const handleCanonical = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;
    if (path[0] !== "v1" || path[1] !== "canonical") {return null;}

    if (path[2] === "search" && path.length === 3 && request.method === "GET") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query) {return jsonEncoded(ErrorBody, { error: "Query parameter q is required" }, 400);}
      const provider = canonicalProvider(url.searchParams.get("provider"));
      if (!provider) {
        return jsonEncoded(ErrorBody, { error: "provider must be all, anilist, or mal" }, 400);
      }

      const result = yield* tryPromise(() =>
        searchCanonical(env, query, provider, searchLimit(url.searchParams.get("limit"))),
      );
      const failedProviders = result.providers.filter((item) => item.error !== undefined);
      const status = failedProviders.length === result.providers.length ? 502 : 200;
      return jsonEncoded(CanonicalSearchResponse, result, status);
    }

    if (
      path[2] === "mangadex" &&
      path[3] === "resolve" &&
      path.length === 4 &&
      request.method === "POST"
    ) {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(MangaDexMatchInput)(raw);
      return jsonEncoded(
        MangaDexMatchResult,
        yield* tryPromise(() => resolveMangaDex(env, input)),
      );
    }

    if (path[2] === "resolve" && path.length === 3 && request.method === "POST") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(ResolveEntryInput)(raw);
      return jsonEncoded(RegistryEntry, yield* tryPromise(() => sync.resolveEntry(input)));
    }

    if (path[2] === "resolve-batch" && path.length === 3 && request.method === "POST") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const raw = yield* parseJson(request);
      if (isJsonArray(raw)) {
        const input = yield* Schema.decodeUnknownEffect(Schema.Array(ResolveEntryInput))(raw);
        return jsonEncoded(RegistryEntriesResponse, {
          entries: yield* tryPromise(() => sync.resolveEntries(input)),
        });
      }
      const input = yield* Schema.decodeUnknownEffect(ResolveEntryInput)(raw);
      return jsonEncoded(RegistryEntriesResponse, {
        entries: yield* tryPromise(() => sync.resolveEntries(input)),
      });
    }

    if (
      path[2] === "by-provider" &&
      path[3] === "mangadex" &&
      path.length === 5 &&
      request.method === "GET"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const entry = yield* tryPromise(() => sync.entryByProvider("mangadex", routeId(path[4])));
      return jsonEncoded(EntryByProviderResponse, { entry: entry ?? null });
    }

    if (path.length === 4 && request.method === "GET") {
      const provider = canonicalProvider(path[2]);
      if (!provider || provider === "all") {
        return jsonEncoded(ErrorBody, { error: "Unknown canonical provider" }, 404);
      }
      const outcome = yield* attempt(() => getCanonical(env, provider, routeId(path[3])));
      if (!outcome.ok) {return jsonEncoded(ErrorBody, { error: outcome.error.message }, 502);}
      return outcome.value
        ? jsonEncoded(CanonicalIdentity, outcome.value)
        : jsonEncoded(ErrorBody, { error: "Not found" }, 404);
    }

    return null;
  });

