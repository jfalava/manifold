import { Effect, Schema } from "effect";
import { getCanonical, searchCanonical, type CanonicalProviderFilter } from "../canonical";
import { ResolveEntryInput } from "../domain";
import {
  attempt,
  json,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";
import { MangaDexMatchInput, resolveMangaDex } from "../mangadex-match";
import { isJsonArray } from "@manifold/json";

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
      if (!query) {return json({ error: "Query parameter q is required" }, 400);}
      const provider = canonicalProvider(url.searchParams.get("provider"));
      if (!provider) {return json({ error: "provider must be all, anilist, or mal" }, 400);}

      const result = yield* tryPromise(() =>
        searchCanonical(env, query, provider, searchLimit(url.searchParams.get("limit"))),
      );
      const failedProviders = result.providers.filter((item) => item.error !== undefined);
      const status = failedProviders.length === result.providers.length ? 502 : 200;
      return json(result, status);
    }

    if (
      path[2] === "mangadex" &&
      path[3] === "resolve" &&
      path.length === 4 &&
      request.method === "POST"
    ) {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(MangaDexMatchInput)(raw);
      return json(yield* tryPromise(() => resolveMangaDex(env, input)));
    }

    if (path[2] === "resolve" && path.length === 3 && request.method === "POST") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(ResolveEntryInput)(raw);
      return json(yield* tryPromise(() => sync.resolveEntry(input)));
    }

    if (path[2] === "resolve-batch" && path.length === 3 && request.method === "POST") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const raw = yield* parseJson(request);
      if (isJsonArray(raw)) {
        const input = yield* Schema.decodeUnknownEffect(Schema.Array(ResolveEntryInput))(raw);
        return json({
          entries: yield* tryPromise(() => sync.resolveEntries(input)),
        });
      }
      const input = yield* Schema.decodeUnknownEffect(ResolveEntryInput)(raw);
      return json({
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
      return entry ? json(entry) : json({ entry: null });
    }

    if (path.length === 4 && request.method === "GET") {
      const provider = canonicalProvider(path[2]);
      if (!provider || provider === "all") {return json({ error: "Unknown canonical provider" }, 404);}
      const outcome = yield* attempt(() => getCanonical(env, provider, routeId(path[3])));
      if (!outcome.ok) {return json({ error: outcome.error.message }, 502);}
      return outcome.value ? json(outcome.value) : json({ error: "Not found" }, 404);
    }

    return null;
  });
