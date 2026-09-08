import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { catalogApp } from "./catalog";
import { ErrorBody } from "@manifold/contract";
import {
  authorized,
  isPublicOAuthRoute,
  json,
  jsonEncoded,
  ResponseEncodeError,
  tryPromise,
  type RouteContext,
} from "./http";
import { ManifoldSync } from "./manifold-sync";
import { handleAuth, handleHealth } from "./routes/health-auth";
import { handleBackups } from "./routes/backups";
import { handleCanonical } from "./routes/canonical";
import { handleMangaDex } from "./routes/mangadex";
import { handleOps } from "./routes/ops";
import { handleRegistry } from "./routes/registry";
import type { Env } from "./types";

export { ManifoldSync };
export type { Env };

const PUBLIC_HOSTNAME = "manifold.jfa.dev";

const handle = (request: Request, env: Env): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    const ctx: RouteContext = { request, env, url, path };

    const health = yield* handleHealth(ctx);
    if (health) {
      return health;
    }

    if (
      !isPublicOAuthRoute(request.method, path) &&
      !(yield* tryPromise(() => authorized(request, env)))
    ) {
      return jsonEncoded(ErrorBody, { error: "Unauthorized" }, 401);
    }

    const canonical = yield* handleCanonical(ctx);
    if (canonical) {
      return canonical;
    }
    const backups = yield* handleBackups(ctx);
    if (backups) {
      return backups;
    }
    const registry = yield* handleRegistry(ctx);
    if (registry) {
      return registry;
    }
    const mangadex = yield* handleMangaDex(ctx);
    if (mangadex) {
      return mangadex;
    }
    const ops = yield* handleOps(ctx);
    if (ops) {
      return ops;
    }
    const auth = yield* handleAuth(ctx);
    if (auth) {
      return auth;
    }
    return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
  });

const app: Hono<{ Bindings: Env }> = new Hono<{ Bindings: Env }>()
  .use("*", async (c, next) => {
    if (new URL(c.req.url).hostname !== PUBLIC_HOSTNAME) {
      return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
    }
    await next();
  })
  .route("/", catalogApp)
  .all("*", async (c) => {
    try {
      return await Effect.runPromise(handle(c.req.raw, c.env));
    } catch (error) {
      if (error instanceof ResponseEncodeError) {
        // Avoid re-entering encode on the error path — plain json.
        return json(
          { error: "Internal server error", details: "Response failed schema encode" },
          500,
        );
      }
      if (error instanceof Schema.SchemaError) {
        console.error(`[manifold/api] schema error:${error.message}`);
        return jsonEncoded(ErrorBody, { error: "Invalid request", details: error.message }, 400);
      }
      const message = error instanceof Error ? error.message : "Internal server error";
      console.error(`[manifold/api] request failed:${message}`);
      return jsonEncoded(ErrorBody, { error: message }, 500);
    }
  });

const worker = {
  fetch: (request: Request, env: Env, executionContext: ExecutionContext) =>
    app.fetch(request, env, executionContext),
  scheduled: async (_controller: ScheduledController, env: Env): Promise<void> => {
    const backup = await env.MANIFOLD_SYNC.getByName("default").backupRegistry();
    console.info(`[manifold/api] scheduled registry backup:${backup.key}`);
  },
};

export default worker;
