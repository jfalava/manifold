import { Effect, Schema } from "effect";
import {
  CompleteOpsInput,
  EnqueuedCountResponse,
  ErrorBody,
  OpsListResponse,
  OpsSummaryResponse,
  RetriedCountResponse,
  SyncOp,
  UpdatedCountResponse,
} from "@manifold/contract";
import {
  jsonEncoded,
  parseJson,
  routeId,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";

export const handleOps = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;

    if (path[0] === "v1" && path[1] === "ops") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      if (
        path.length === 4 &&
        path[2] === "pending" &&
        path[3] === "anilist" &&
        request.method === "GET"
      ) {
        return jsonEncoded(OpsListResponse, {
          ops: yield* tryPromise(() =>
            sync.pendingAniListOps(Number(url.searchParams.get("limit") ?? 25) || 25),
          ),
        });
      }
      if (path.length === 3 && path[2] === "complete" && request.method === "POST") {
        const raw = yield* parseJson(request);
        const input = yield* Schema.decodeUnknownEffect(CompleteOpsInput)(raw);
        return jsonEncoded(UpdatedCountResponse, yield* tryPromise(() => sync.completeOps(input)));
      }
      if (path.length === 3 && path[2] === "summary" && request.method === "GET") {
        return jsonEncoded(OpsSummaryResponse, {
          summary: yield* tryPromise(() =>
            sync.opsSummary(Number(url.searchParams.get("limit") ?? 200) || 200),
          ),
        });
      }
      if (path.length === 2 && request.method === "GET") {
        return jsonEncoded(OpsListResponse, {
          ops: yield* tryPromise(() =>
            sync.listOps(
              url.searchParams.get("state") ?? undefined,
              url.searchParams.get("target") ?? undefined,
              Number(url.searchParams.get("limit") ?? 200) || 200,
            ),
          ),
        });
      }
      if (path.length === 4 && path[3] === "retry" && request.method === "POST") {
        const op = yield* tryPromise(() => sync.retryOp(routeId(path[2])));
        return op ? jsonEncoded(SyncOp, op) : jsonEncoded(ErrorBody, { error: "Not found" }, 404);
      }
      return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
    }

    if (
      path[0] === "v1" &&
      path[1] === "sync" &&
      path[2] === "retry" &&
      request.method === "POST"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return jsonEncoded(RetriedCountResponse, yield* tryPromise(() => sync.retryFailedSync()));
    }

    if (
      path[0] === "v1" &&
      path[1] === "sync" &&
      path[2] === "mangadex" &&
      path[3] === "shelf-backfill" &&
      request.method === "POST"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return jsonEncoded(
        EnqueuedCountResponse,
        yield* tryPromise(() => sync.backfillMangaDexShelf()),
      );
    }

    return null;
  });
