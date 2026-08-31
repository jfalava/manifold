import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { getCanonical, searchCanonical, type CanonicalProviderFilter } from "./canonical";
import { catalogApp } from "./catalog";
import type { AuthProvider, OAuthProvider } from "./domain";
import { resolveMangaDex } from "./mangadex-match";
import { readSecret } from "./read-secret";
import { ManifoldSync } from "./manifold-sync";
import type { Env } from "./types";

export { ManifoldSync };
export type { Env };

const PUBLIC_HOSTNAME = "manifold.jfa.dev";

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });

const parseJson = (request: Request): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new Error("Request body must be valid JSON")
  });

const toError = (cause: unknown): Error => {
  if (cause instanceof Error) return cause;
  // Canonical source failures reject with plain { _tag, message } objects.
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return new Error(String((cause as { message: unknown }).message));
  }
  return new Error(String(cause));
};

const tryPromise = <A>(action: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: action,
    catch: toError,
  });

// Like tryPromise but captures failure as a value, for routes that answer
// with an upstream-failure status instead of a generic 500.
const attempt = <A>(
  action: () => Promise<A>,
): Effect.Effect<{ ok: true; value: A } | { ok: false; error: Error }> =>
  Effect.promise(async () => {
    try {
      return { ok: true, value: await action() } as const;
    } catch (cause) {
      return { ok: false, error: toError(cause) } as const;
    }
  });

const routeId = (value: string): string => decodeURIComponent(value);

const authorized = async (request: Request, env: Env): Promise<boolean> => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;

  const expected = await readSecret(env.MANIFOLD_TOKEN, "MANIFOLD_TOKEN");
  const supplied = new TextEncoder().encode(authorization.slice("Bearer ".length));
  const suppliedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", supplied)
  );
  const expectedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected))
  );
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= suppliedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
};

const authProvider = (value: string | undefined): AuthProvider | undefined => {
  if (value === "anilist" || value === "mal" || value === "mangadex") return value;
  return undefined;
};

const oauthProvider = (value: string | undefined): OAuthProvider | undefined => {
  if (value === "anilist" || value === "mal") return value;
  return undefined;
};

const canonicalProvider = (value: string | null): CanonicalProviderFilter | undefined => {
  if (value === null || value === "all") return "all";
  if (value === "anilist" || value === "mal") return value;
  return undefined;
};

const searchLimit = (value: string | null): number => {
  const parsed = value === null ? 20 : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(25, Math.max(1, parsed));
};

const oauthRedirectUri = (provider: OAuthProvider, env: Env): string => {
  const base = env.OAUTH_REDIRECT_BASE_URL.replace(/\/+$/, "");
  // Older deployments stored the bare origin; the router mounts SyncApi under /api.
  // NOTE: new URL() would discard the base's path for an absolute path arg — concatenate.
  const normalized = base.endsWith("/api") ? base : `${base}/api`;
  return `${normalized}/v1/auth/${provider}/callback`;
};

const isOAuthCallback = (path: readonly string[]): boolean =>
  (path.length === 4 &&
    path[0] === "v1" &&
    path[1] === "auth" &&
    path[3] === "callback" &&
    oauthProvider(path[2]) !== undefined) ||
  (path.length === 4 && path[2] === "anilist" && path[3] === "device");

const handle = (request: Request, env: Env): Effect.Effect<Response, unknown> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT, build: "p1-oauth-fix-2" });
    }

    const callback = isOAuthCallback(path);
    if (!callback && !(yield* tryPromise(() => authorized(request, env)))) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (
      path[0] === "v1" &&
      path[1] === "canonical" &&
      path[2] === "search" &&
      path.length === 3 &&
      request.method === "GET"
    ) {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query) return json({ error: "Query parameter q is required" }, 400);
      const provider = canonicalProvider(url.searchParams.get("provider"));
      if (!provider) return json({ error: "provider must be all, anilist, or mal" }, 400);

      const result = yield* tryPromise(() =>
        searchCanonical(env, query, provider, searchLimit(url.searchParams.get("limit")))
      );
      const failedProviders = result.providers.filter((item) => item.error !== undefined);
      const status = failedProviders.length === result.providers.length ? 502 : 200;
      return json(result, status);
    }

    if (
      path[0] === "v1" &&
      path[1] === "canonical" &&
      path.length === 4 &&
      request.method === "GET"
    ) {
      const provider = canonicalProvider(path[2]);
      if (!provider || provider === "all") return json({ error: "Unknown canonical provider" }, 404);
      // Upstream provider failures (e.g. AniList blocking Worker egress)
      // must surface as 502 with the real message, not a bare 500.
      const outcome = yield* attempt(() => getCanonical(env, provider, routeId(path[3])));
      if (!outcome.ok) return json({ error: outcome.error.message }, 502);
      return outcome.value ? json(outcome.value) : json({ error: "Not found" }, 404);
    }

    if (
      path[0] === "v1" &&
      path[1] === "canonical" &&
      path[2] === "mangadex" &&
      path[3] === "resolve" &&
      path.length === 4 &&
      request.method === "POST"
    ) {
      const body = yield* parseJson(request);
      return json(yield* tryPromise(() => resolveMangaDex(env, body)));
    }

    // Registry: lazy-mint a provider-neutral UUID row for one provider id.
    if (
      path[0] === "v1" &&
      path[1] === "canonical" &&
      path[2] === "resolve" &&
      path.length === 3 &&
      request.method === "POST"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const body = yield* parseJson(request);
      return json(yield* tryPromise(() => sync.resolveEntry(body)));
    }

    if (
      path[0] === "v1" &&
      path[1] === "canonical" &&
      path[2] === "resolve-batch" &&
      path.length === 3 &&
      request.method === "POST"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const body = yield* parseJson(request);
      return json(
        { entries: yield* tryPromise(() => sync.resolveEntries(body)) }
      );
    }

    // Registry browse for the admin panel (also powers the one-time CLI
    // prefills). The legacy frontend used a fixed LIMIT 500 and silently
    // paginated the rest out of view — the bulk tools now page through
    // everything. Default stays 500 for backward compatibility.
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
            Number(url.searchParams.get("limit") ?? 100) || 100
          )
        )
      });
    }

    // Op log: pending anilist ops are fetched and executed by the device;
    // the Worker only ever drains mangadex targets.
    if (path[0] === "v1" && path[1] === "ops") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      if (path.length === 4 && path[2] === "pending" && path[3] === "anilist" && request.method === "GET") {
        return json({
          ops: yield* tryPromise(() =>
            sync.pendingAniListOps(Number(url.searchParams.get("limit") ?? 25) || 25)
          )
        });
      }
      if (path.length === 3 && path[2] === "complete" && request.method === "POST") {
        const body = yield* parseJson(request);
        return json(yield* tryPromise(() => sync.completeOps(body)));
      }
      if (path.length === 2 && request.method === "GET") {
        return json({
          ops: yield* tryPromise(() =>
            sync.listOps(
              url.searchParams.get("state") ?? undefined,
              url.searchParams.get("target") ?? undefined,
              Number(url.searchParams.get("limit") ?? 200) || 200
            )
          )
        });
      }
      if (path.length === 4 && path[3] === "retry" && request.method === "POST") {
        const op = yield* tryPromise(() => sync.retryOp(routeId(path[2])));
        return op ? json(op) : json({ error: "Not found" }, 404);
      }
      return json({ error: "Not found" }, 404);
    }

    if (path[0] === "v1" && path[1] === "sync" && path[2] === "retry" && request.method === "POST") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return json(yield* tryPromise(() => sync.retryFailedSync()));
    }

    if (
      path[0] === "v1" &&
      path[1] === "sync" &&
      path[2] === "mangadex" &&
      path[3] === "shelf-backfill" &&
      request.method === "POST"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return json(yield* tryPromise(() => sync.backfillMangaDexShelf()));
    }

    if (path[0] === "v1" && path[1] === "auth" && path[2] === "anilist" && path[3] === "device") {
      const redirectUri = `${env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, "")}/v1/auth/anilist/device`;
      const authorizeUrl =
        `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(env.ANILIST_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token`;
      const html = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:-apple-system,sans-serif;padding:20px;max-width:480px;margin:0 auto}
 h3{margin:0 0 12px}
 #token{width:100%;height:110px;font-family:monospace;font-size:13px;padding:10px;
        border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box;background:#f8fafc}
 button{display:block;width:100%;padding:14px;border:none;border-radius:10px;
        font-size:16px;font-weight:600;margin-top:12px;color:#fff;background:#2563eb}
 button.secondary{background:#64748b}
 button:disabled{opacity:.5}
 small{color:#64748b;display:block;margin-top:10px}
</style></head>
<body>
<h3>AniList token capture</h3>
<p id="status">Reading token from URL…</p>
<textarea id="token" readonly placeholder="Your token will appear here"></textarea>
<button id="copy" style="display:none" onclick="copyToken()">Copy token</button>
<button id="start" style="display:none" onclick="location.href='${authorizeUrl}'">Connect AniList</button>
<p id="copy-hint" style="display:none"><small>Paste this into manifold: tracker → Settings → AniList token (or the privatize script).</small></p>
<script>
  var m = location.hash.match(/access_token=([^&]+)/);
  if (m) {
    document.getElementById("token").value = decodeURIComponent(m[1]);
    document.getElementById("status").textContent = "Token captured.";
    document.getElementById("copy").style.display = "block";
    document.getElementById("copy-hint").style.display = "block";
    document.getElementById("copy").textContent = "Copy token";
  } else {
    document.getElementById("status").textContent = "No token yet — start the authorization below.";
    document.getElementById("start").style.display = "block";
  }
  function copyToken() {
    var box = document.getElementById("token");
    var done = function () {
      var b = document.getElementById("copy");
      b.textContent = "Copied ✓";
      setTimeout(function () { b.textContent = "Copy token"; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(done).catch(function () { legacyCopy(box); done(); });
    } else {
      legacyCopy(box); done();
    }
  }
  function legacyCopy(box) {
    box.focus(); box.select(); box.setSelectionRange(0, 999999);
    try { document.execCommand("copy"); } catch (e) {}
  }
</script>
</body></html>`;
      return new Response(html, { headers: { "content-type": "text/html" } });
    }

    if (path[0] === "v1" && path[1] === "mangadex") {
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
      if (path.length === 3 && path[2] === "stats" && request.method === "POST") {
        const body = yield* parseJson(request);
        const candidate = (body as { ids?: unknown } | null | undefined)?.ids;
        const ids = Array.isArray(candidate)
          ? candidate.filter((value): value is string => typeof value === "string").slice(0, 200)
          : [];
        if (ids.length === 0) return json({ error: "No manga ids provided" }, 400);
        return json({ stats: yield* tryPromise(() => sync.mangaDexStats(ids)) });
      }
      if (path.length === 3 && path[2] === "feed" && request.method === "GET") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        return json(yield* tryPromise(() => sync.mangaDexFeed(limit, offset)));
      }
      if (path.length === 4 && path[2] === "status" && request.method === "POST") {
        const body = yield* parseJson(request);
        yield* tryPromise(() => sync.setMangaDexStatus(routeId(path[3]), body));
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    }

    if (
      path[0] === "v1" &&
      path[1] === "canonical" &&
      path[2] === "by-provider" &&
      path[3] === "mangadex" &&
      path.length === 5 &&
      request.method === "GET"
    ) {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      const entry = yield* tryPromise(() => sync.entryByProvider("mangadex", routeId(path[4])));
      return entry ? json(entry) : json({ entry: null });
    }

    if (path[0] === "v1" && path[1] === "auth") {
      if (path.length === 2 && request.method === "GET") {
        const sync = env.MANIFOLD_SYNC.getByName("default");
        return json(yield* tryPromise(() => sync.listAuthConnections()));
      }

      const provider = authProvider(path[2]);
      if (!provider) return json({ error: "Unknown auth provider" }, 404);

      const sync = env.MANIFOLD_SYNC.getByName("default");
      if (
        provider === "mangadex" &&
        path.length === 4 &&
        path[3] === "login" &&
        request.method === "POST"
      ) {
        return json(yield* tryPromise(() => sync.loginMangaDex()));
      }

      const oauth = oauthProvider(provider);
      if (oauth && path.length === 4 && path[3] === "start" && request.method === "GET") {
        const start = yield* tryPromise(() =>
          sync.createOAuthSession(oauth, oauthRedirectUri(oauth, env))
        );
        return new Response(null, {
          status: 302,
          headers: {
            location: start.authorizationUrl,
            "cache-control": "no-store"
          }
        });
      }

      if (oauth && path.length === 4 && path[3] === "callback" && request.method === "GET") {
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (!state) {
          // No state + no code means an OAuth *implicit* return (the admin
          // app's migration flow): the access_token lives in the URL
          // fragment, which never reaches the server. Hand the browser back
          // to the admin app so its client-side capture can pick it up.
          if (path[2] === "anilist" && !error && !url.searchParams.get("code")) {
            const html = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to admin…</title></head>
<body><p>Returning to the admin app…</p>
<script>location.replace("/admin" + location.hash)</script>
<p><a href="/admin">Continue if you are not redirected.</a></p>
</body></html>`;
            return new Response(html, {
              headers: { "content-type": "text/html", "cache-control": "no-store" }
            });
          }
          return json({ error: "OAuth callback is missing state" }, 400);
        }
        if (error) {
          yield* tryPromise(() => sync.cancelOAuthSession(oauth, state));
          return json({ error: "OAuth authorization was denied", provider: oauth }, 400);
        }

        const code = url.searchParams.get("code");
        if (!code) return json({ error: "OAuth callback is missing code" }, 400);
        return json(
          yield* tryPromise(() => sync.completeOAuthSession(oauth, state, code))
        );
      }

      if (path.length === 3 && request.method === "GET") {
        return json(yield* tryPromise(() => sync.getAuthConnection(provider)));
      }

      if (path.length === 3 && request.method === "DELETE") {
        yield* tryPromise(() => sync.disconnectAuth(provider));
        return json({ provider, connected: false });
      }

      return json({ error: "Not found" }, 404);
    }

    if (path[0] !== "v1" || path[1] !== "entries") return json({ error: "Not found" }, 404);

    const sync = env.MANIFOLD_SYNC.getByName("default");

    if (path.length === 2 && request.method === "GET") {
      return json({ entries: yield* tryPromise(() => sync.listEntries()) });
    }

    if (path.length === 2 && request.method === "POST") {
      const body = yield* parseJson(request);
      return json(yield* tryPromise(() => sync.upsertEntry(body)), 201);
    }

    if (path.length < 3) return json({ error: "Not found" }, 404);
    const entryId = routeId(path[2]);

    if (path.length === 3 && request.method === "GET") {
      const entry = yield* tryPromise(() => sync.getEntry(entryId));
      return entry ? json(entry) : json({ error: "Not found" }, 404);
    }

    if (path[3] === "providers" && path.length === 4 && request.method === "POST") {
      const body = yield* parseJson(request);
      return json(
        yield* tryPromise(() => sync.linkProvider(entryId, body))
      );
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
      const body = yield* parseJson(request);
      return json(
        yield* tryPromise(() => sync.recordRead(entryId, body))
      );
    }

    if (path[3] === "list-state" && path.length === 4 && request.method === "GET") {
      const state = yield* tryPromise(() => sync.getListState(entryId));
      return state ? json(state) : json({ state: null });
    }

    if (path[3] === "list-state" && path.length === 4 && request.method === "POST") {
      const body = yield* parseJson(request);
      return json(yield* tryPromise(() => sync.setListState(entryId, body)));
    }

    // Removal is a nuke: AniList entry deleted, registry row tombstoned.
    if (path[3] === "delete" && path.length === 4 && request.method === "POST") {
      const body = yield* parseJson(request).pipe(Effect.orElseSucceed(() => ({})));
      const state = yield* tryPromise(() => sync.nukeEntry(entryId, body));
      return json({ ok: true, ...(state ? { state } : {}) });
    }

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
