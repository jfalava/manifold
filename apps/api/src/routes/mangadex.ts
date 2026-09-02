import { Effect, Schema } from "effect";
import { isJsonArray, isJsonObject, isString } from "@manifold/json";
import { SetMangaDexStatusInput } from "../domain";
import {
  json,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";

export const handleMangaDex = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;
    if (path[0] !== "v1" || path[1] !== "mangadex") {return null;}

    const sync = env.MANIFOLD_SYNC.getByName("default");
    if (path.length === 3 && path[2] === "me" && request.method === "GET") {
      return json(yield* tryPromise(() => sync.mangaDexCurrentUser()));
    }
    if (path.length === 4 && path[2] === "read-markers" && request.method === "GET") {
      return json({
        chapters: yield* tryPromise(() => sync.mangaDexReadMarkers(routeId(path[3]))),
      });
    }
    if (path.length === 3 && path[2] === "library" && request.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return json({
        library: yield* tryPromise(() => sync.mangaDexLibrary(status)),
      });
    }
    if (path.length === 4 && path[2] === "library" && path[3] === "summary" && request.method === "GET") {
      return json({
        summary: yield* tryPromise(() => sync.mangaDexLibrarySummary()),
      });
    }
    if (path.length === 3 && path[2] === "stats" && request.method === "POST") {
      const raw = yield* parseJson(request);
      const idsField = isJsonObject(raw) ? raw.ids : undefined;
      const ids = isJsonArray(idsField)
        ? idsField.filter(isString).slice(0, 200)
        : [];
      if (ids.length === 0) {return json({ error: "No manga ids provided" }, 400);}
      return json({ stats: yield* tryPromise(() => sync.mangaDexStats(ids)) });
    }
    if (path.length === 3 && path[2] === "feed" && request.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      return json(yield* tryPromise(() => sync.mangaDexFeed(limit, offset)));
    }
    if (path.length === 4 && path[2] === "status" && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(SetMangaDexStatusInput)(raw);
      yield* tryPromise(() => sync.setMangaDexStatus(routeId(path[3]), input));
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  });
