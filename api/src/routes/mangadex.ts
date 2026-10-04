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
  boundedInteger,
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
      const mangaId = yield* routeId(path[3]);
      return jsonEncoded(MangaDexReadMarkersResponse, {
        chapters: yield* tryPromise(() => sync.mangaDexReadMarkers(mangaId)),
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
      const ids = isJsonArray(idsField)
        ? idsField.filter((id): id is string => isString(id) && id.trim().length > 0).slice(0, 200)
        : [];
      if (ids.length === 0) {
        return jsonEncoded(ErrorBody, { error: "No manga ids provided" }, 400);
      }
      return jsonEncoded(MangaDexStatsResponse, {
        stats: yield* tryPromise(() => sync.mangaDexStats(ids)),
      });
    }
    if (path.length === 3 && path[2] === "feed" && request.method === "GET") {
      const limit = boundedInteger(url.searchParams.get("limit"), 20, 1, 100);
      const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
      return jsonEncoded(
        MangaDexFeedPage,
        yield* tryPromise(() => sync.mangaDexFeed(limit, offset)),
      );
    }
    if (path.length === 4 && path[2] === "status" && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(SetMangaDexStatusInput)(raw);
      const mangaDexId = yield* routeId(path[3]);
      yield* tryPromise(() => sync.setMangaDexStatus(mangaDexId, input));
      return jsonEncoded(OkResponse, { ok: true as const });
    }
    return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
  });
