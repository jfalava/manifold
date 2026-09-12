import { Effect, Schema } from "effect";
import {
  CanonicalIdentity,
  ErrorBody,
  IngestCandidateInput,
  LinkProviderInput,
  ListState,
  ListStateResponse,
  NukeEntryInput,
  OkWithListStateResponse,
  ProgressResponse,
  ReadingProgress,
  RecordReadInput,
  RegistryEntriesResponse,
  RegistryEntry,
  RegistryListResponse,
  RegistrySummaryResponse,
  EventsListResponse,
  SetListStateInput,
  UpsertEntryInput,
} from "@manifold/contract";
import {
  jsonEncoded,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";
import { getRegistryCanonical } from "../canonical";

export const handleRegistry = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;

    if (
      path[0] === "v1" &&
      path[1] === "registry" &&
      path.length === 2 &&
      request.method === "GET"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const limit = Number(url.searchParams.get("limit") ?? 500) || 500;
      const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
      return jsonEncoded(RegistryListResponse, {
        entries: yield* tryPromise(() => sync.listRegistry(limit, offset)),
      });
    }

    if (
      path[0] === "v1" &&
      path[1] === "registry" &&
      path[2] === "search" &&
      path.length === 3 &&
      request.method === "GET"
    ) {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query) {
        return jsonEncoded(ErrorBody, { error: "Query parameter q is required" }, 400);
      }
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
      return jsonEncoded(RegistryEntriesResponse, {
        entries: yield* tryPromise(() => sync.searchRegistry(query, limit)),
      });
    }

    if (
      path[0] === "v1" &&
      path[1] === "registry" &&
      path[2] === "ingest" &&
      path.length === 3 &&
      request.method === "POST"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(IngestCandidateInput)(raw);
      return jsonEncoded(RegistryEntry, yield* tryPromise(() => sync.ingestCandidate(input)));
    }

    if (
      path[0] === "v1" &&
      path[1] === "registry" &&
      path.length === 3 &&
      path[2] === "summary" &&
      request.method === "GET"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return jsonEncoded(RegistrySummaryResponse, {
        summary: yield* tryPromise(() => sync.registrySummary()),
      });
    }

    if (path[0] === "v1" && path[1] === "events" && path.length === 2 && request.method === "GET") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return jsonEncoded(EventsListResponse, {
        events: yield* tryPromise(() =>
          sync.listEvents(
            url.searchParams.get("entryId") ?? undefined,
            Number(url.searchParams.get("limit") ?? 100) || 100,
          ),
        ),
      });
    }

    if (path[0] !== "v1" || path[1] !== "entries") {
      return null;
    }

    const sync = env.MANIFOLD_SYNC.getByName("default");

    if (path.length === 2 && request.method === "GET") {
      return jsonEncoded(RegistryEntriesResponse, {
        entries: yield* tryPromise(() => sync.listEntries()),
      });
    }

    if (path.length === 2 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(UpsertEntryInput)(raw);
      return jsonEncoded(RegistryEntry, yield* tryPromise(() => sync.upsertEntry(input)), 201);
    }

    if (path.length < 3) {
      return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
    }
    const entryId = routeId(path[2]);

    if (path[3] === "canonical" && path.length === 4 && request.method === "GET") {
      const entry = yield* tryPromise(() => sync.getEntry(entryId));
      return entry
        ? jsonEncoded(CanonicalIdentity, yield* tryPromise(() => getRegistryCanonical(env, entry)))
        : jsonEncoded(ErrorBody, { error: "Not found" }, 404);
    }

    if (path.length === 3 && request.method === "GET") {
      const entry = yield* tryPromise(() => sync.getEntry(entryId));
      return entry
        ? jsonEncoded(RegistryEntry, entry)
        : jsonEncoded(ErrorBody, { error: "Not found" }, 404);
    }

    if (path[3] === "providers" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(LinkProviderInput)(raw);
      return jsonEncoded(RegistryEntry, yield* tryPromise(() => sync.linkProvider(entryId, input)));
    }

    if (path[3] === "unlink" && path.length === 5 && request.method === "POST") {
      const provider = path[4];
      if (!["anilist", "mal", "mangadex", "comix"].includes(provider)) {
        return jsonEncoded(ErrorBody, { error: "Unknown provider" }, 400);
      }
      return jsonEncoded(
        RegistryEntry,
        yield* tryPromise(() => sync.unlinkProvider(entryId, provider)),
      );
    }

    if (path[3] === "progress" && path.length === 4 && request.method === "GET") {
      const progress = yield* tryPromise(() => sync.getProgress(entryId));
      return jsonEncoded(ProgressResponse, { progress: progress ?? null });
    }

    if (path[3] === "read" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(RecordReadInput)(raw);
      return jsonEncoded(ReadingProgress, yield* tryPromise(() => sync.recordRead(entryId, input)));
    }

    if (path[3] === "list-state" && path.length === 4 && request.method === "GET") {
      const state = yield* tryPromise(() => sync.getListState(entryId));
      return jsonEncoded(ListStateResponse, { state: state ?? null });
    }

    if (path[3] === "list-state" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(SetListStateInput)(raw);
      return jsonEncoded(ListState, yield* tryPromise(() => sync.setListState(entryId, input)));
    }

    if (path[3] === "delete" && path.length === 4 && request.method === "POST") {
      const raw = yield* parseJson(request).pipe(Effect.orElseSucceed(() => ({})));
      const input = yield* Schema.decodeUnknownEffect(NukeEntryInput)(raw);
      const state = yield* tryPromise(() => sync.nukeEntry(entryId, input));
      return jsonEncoded(OkWithListStateResponse, { ok: true as const, ...(state && { state }) });
    }

    return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
  });
