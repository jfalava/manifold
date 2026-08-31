import { Effect } from "effect";
import {
  authProvider,
  json,
  oauthProvider,
  oauthRedirectUri,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";

const anilistDevicePage = (authorizeUrl: string): string => `<!DOCTYPE html>
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

const anilistImplicitReturnPage = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to admin…</title></head>
<body><p>Returning to the admin app…</p>
<script>location.replace("/admin" + location.hash)</script>
<p><a href="/admin">Continue if you are not redirected.</a></p>
</body></html>`;

export const handleHealth = (ctx: RouteContext): RouteEffect =>
  Effect.sync(() => {
    if (ctx.request.method === "GET" && ctx.url.pathname === "/health") {
      return json({ ok: true, environment: ctx.env.ENVIRONMENT, build: "p1-oauth-fix-2" });
    }
    return null;
  });

export const handleAuth = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;
    if (path[0] === "v1" && path[1] === "auth" && path[2] === "anilist" && path[3] === "device") {
      const redirectUri = `${env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, "")}/v1/auth/anilist/device`;
      const authorizeUrl =
        `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(env.ANILIST_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token`;
      return new Response(anilistDevicePage(authorizeUrl), {
        headers: { "content-type": "text/html" },
      });
    }

    if (path[0] !== "v1" || path[1] !== "auth") {return null;}

    if (path.length === 2 && request.method === "GET") {
      const sync = env.MANIFOLD_SYNC.getByName("default");
      return json(yield* tryPromise(() => sync.listAuthConnections()));
    }

    const provider = authProvider(path[2]);
    if (!provider) {return json({ error: "Unknown auth provider" }, 404);}

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
        sync.createOAuthSession(oauth, oauthRedirectUri(oauth, env)),
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: start.authorizationUrl,
          "cache-control": "no-store",
        },
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
          return new Response(anilistImplicitReturnPage, {
            headers: { "content-type": "text/html", "cache-control": "no-store" },
          });
        }
        return json({ error: "OAuth callback is missing state" }, 400);
      }
      if (error) {
        yield* tryPromise(() => sync.cancelOAuthSession(oauth, state));
        return json({ error: "OAuth authorization was denied", provider: oauth }, 400);
      }

      const code = url.searchParams.get("code");
      if (!code) {return json({ error: "OAuth callback is missing code" }, 400);}
      return json(
        yield* tryPromise(() => sync.completeOAuthSession(oauth, state, code)),
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
  });
