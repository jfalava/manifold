/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { Effect, Schema } from "effect";
import {
  ErrorBody,
  MangaDexFeedPage,
  MangaDexLibraryResponse,
  MangaDexLibrarySummaryResponse,
  MangaDexReadMarkersResponse,
  MangaDexStatsResponse,
  MangaDexUserResponse,
  OkResponse,
  SetMangaDexStatusInput,
} from "@manifold/contract";
import { isJsonArray, isJsonObject, isString } from "@manifold/json";
import {
  jsonEncoded,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";

export const handleMangaDex = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;
    if (path[0] !== "v1" || path[1] !== "mangadex") {
      return null;
    }

    const sync = env.MANIFOLD_SYNC.getByName("default");
    if (path.length === 3 && path[2] === "me" && request.method === "GET") {
      return jsonEncoded(MangaDexUserResponse, yield* tryPromise(() => sync.mangaDexCurrentUser()));
    }
    if (path.length === 4 && path[2] === "read-markers" && request.method === "GET") {
      return jsonEncoded(MangaDexReadMarkersResponse, {
        chapters: yield* tryPromise(() => sync.mangaDexReadMarkers(routeId(path[3]))),
      });
    }
    if (path.length === 3 && path[2] === "library" && request.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return jsonEncoded(MangaDexLibraryResponse, {
        library: yield* tryPromise(() => sync.mangaDexLibrary(status)),
      });
    }
    if (
      path.length === 4 &&
      path[2] === "library" &&
      path[3] === "summary" &&
      request.method === "GET"
    ) {
      return jsonEncoded(MangaDexLibrarySummaryResponse, {
        summary: yield* tryPromise(() => sync.mangaDexLibrarySummary()),
      });
    }
    if (path.length === 3 && path[2] === "stats" && request.method === "POST") {
      const raw = yield* parseJson(request);
      const idsField = isJsonObject(raw) ? raw.ids : undefined;
      const ids = isJsonArray(idsField) ? idsField.filter(isString).slice(0, 200) : [];
      if (ids.length === 0) {
        return jsonEncoded(ErrorBody, { error: "No manga ids provided" }, 400);
      }
      return jsonEncoded(MangaDexStatsResponse, {
        stats: yield* tryPromise(() => sync.mangaDexStats(ids)),
      });
    }
    if (path.length === 3 && path[2] === "feed" && request.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      return jsonEncoded(
        MangaDexFeedPage,
        yield* tryPromise(() => sync.mangaDexFeed(limit, offset)),
      );
    }
    if (path.length === 4 && path[2] === "status" && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(SetMangaDexStatusInput)(raw);
      yield* tryPromise(() => sync.setMangaDexStatus(routeId(path[3]), input));
      return jsonEncoded(OkResponse, { ok: true as const });
    }
    return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
  });
