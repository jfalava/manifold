import { Effect, Schema } from "effect";
import {
  LinkProviderInput,
  NukeEntryInput,
  RecordReadInput,
  SetListStateInput,
  UpsertEntryInput,
} from "../domain";
import {
  json,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";

export const handleRegistry = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;

    if (path[0] === "v1" && path[1] === "registry" && path.length === 2 && request.method === "GET") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const limit = Number(url.searchParams.get("limit") ?? 500) || 500;
      const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
      return json({
        entries: yield* tryPromise(() => sync.listRegistry(limit, offset)),
      });
    }

    if (path[0] === "v1" && path[1] === "events" && path.length === 2 && request.method === "GET") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return json({
        events: yield* tryPromise(() =>
          sync.listEvents(
            url.searchParams.get("entryId") ?? undefined,
            Number(url.searchParams.get("limit") ?? 100) || 100,
          ),
        ),
      });
    }

    if (path[0] !== "v1" || path[1] !== "entries") {return null;}

    const sync = env.MANIFOLD_SYNC.getByName("default");

    if (path.length === 2 && request.method === "GET") {
      return json({ entries: yield* tryPromise(() => sync.listEntries()) });
    }

    if (path.length === 2 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(UpsertEntryInput)(raw);
      return json(yield* tryPromise(() => sync.upsertEntry(input)), 201);
    }

    if (path.length < 3) {return json({ error: "Not found" }, 404);}
    const entryId = routeId(path[2]);

    if (path.length === 3 && request.method === "GET") {
      const entry = yield* tryPromise(() => sync.getEntry(entryId));
      return entry ? json(entry) : json({ error: "Not found" }, 404);
    }

    if (path[3] === "providers" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(LinkProviderInput)(raw);
      return json(yield* tryPromise(() => sync.linkProvider(entryId, input)));
    }

    if (path[3] === "unlink" && path.length === 5 && request.method === "POST") {
      const provider = path[4];
      if (!["anilist", "mal", "mangadex", "comix"].includes(provider)) {
        return json({ error: "Unknown provider" }, 400);
      }
      return json(yield* tryPromise(() => sync.unlinkProvider(entryId, provider)));
    }

    if (path[3] === "progress" && path.length === 4 && request.method === "GET") {
      const progress = yield* tryPromise(() => sync.getProgress(entryId));
      return progress ? json(progress) : json({ progress: null });
    }

    if (path[3] === "read" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(RecordReadInput)(raw);
      return json(yield* tryPromise(() => sync.recordRead(entryId, input)));
    }

    if (path[3] === "list-state" && path.length === 4 && request.method === "GET") {
      const state = yield* tryPromise(() => sync.getListState(entryId));
      return state ? json(state) : json({ state: null });
    }

    if (path[3] === "list-state" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(SetListStateInput)(raw);
      return json(yield* tryPromise(() => sync.setListState(entryId, input)));
    }

    if (path[3] === "delete" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request).pipe(Effect.orElseSucceed(() => ({})));
      const input = yield* Schema.decodeUnknownEffect(NukeEntryInput)(raw);
      const state = yield* tryPromise(() => sync.nukeEntry(entryId, input));
      return json({ ok: true, ...(state && { state }) });
    }

    return json({ error: "Not found" }, 404);
  });
