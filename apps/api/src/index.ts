import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { catalogApp } from "./catalog";
import {
  authorized,
  isOAuthCallback,
  json,
  tryPromise,
  type RouteContext,
} from "./http";
import { ManifoldSync } from "./manifold-sync";
import { handleAuth, handleHealth } from "./routes/health-auth";
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
    if (health) {return health;}

    if (!isOAuthCallback(path) && !(yield* tryPromise(() => authorized(request, env)))) {
      return json({ error: "Unauthorized" }, 401);
    }

    const canonical = yield* handleCanonical(ctx);
    if (canonical) {return canonical;}
    const registry = yield* handleRegistry(ctx);
    if (registry) {return registry;}
    const mangadex = yield* handleMangaDex(ctx);
    if (mangadex) {return mangadex;}
    const ops = yield* handleOps(ctx);
    if (ops) {return ops;}
    const auth = yield* handleAuth(ctx);
    if (auth) {return auth;}
    return json({ error: "Not found" }, 404);
  });

const app: Hono<{ Bindings: Env }> = new Hono<{ Bindings: Env }>()
  .use("*", async (c, next) => {
    if (new URL(c.req.url).hostname !== PUBLIC_HOSTNAME) {
      return json({ error: "Not found" }, 404);
    }
    await next();
  })
  .route("/", catalogApp)
  .all("*", async (c) => {
    try {
      return await Effect.runPromise(handle(c.req.raw, c.env));
    } catch (error) {
      if (error instanceof Schema.SchemaError) {
        return json({ error: "Invalid request", details: error.message }, 400);
      }
      const message = error instanceof Error ? error.message : "Internal server error";
      return json({ error: message }, 500);
    }
  });

export default app;
