/**
 * Custom TanStack Start server entry (same shape as jfa.dev keweke).
 *
 * manifold-admin is only reached through the edge router's service binding
 * (`env.ADMIN.fetch`). That path always invokes this user Worker — platform
 * assets-first routing is skipped — so CSS/JS/fonts must be fetched from the
 * ASSETS binding here. Keweke gets away without this only when the platform
 * asset layer still answers; under a service binding we cannot rely on that.
 *
 * Try the request path as-is (Vite `base: "/admin/"` keys), then the same path
 * with the mount stripped (if the upload manifest was un-prefixed).
 *
 * Only GET/HEAD hit ASSETS. POST/PUT/… (TanStack serverFns) must reach the
 * Start handler with an unread body — `new Request(url, request)` shares the
 * body stream, and ASSETS.fetch consumes it → "Cannot reconstruct a Request
 * with a used body" / HTTP 500 on registry binds and other mutations.
 */
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";

const MOUNT = "/admin";

type AssetsFetcher = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

/**
 * Cloudflare host proxies (ASSETS, service bindings) are not plain objects and
 * may not support `in`. Match jfa.dev/function/router `isFetcher`.
 */
function isFetcher(value: unknown): value is AssetsFetcher {
  if (value === null || value === undefined || Object(value) !== value) {
    return false;
  }
  // SAFETY: host binding; shape is not a plain object.
  const fetchFn = (value as { fetch?: unknown }).fetch;
  return Object.prototype.toString.call(fetchFn).endsWith("Function]");
}

function withPathname(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  // Never forward the original body into ASSETS — static lookups are bodyless
  // and cloning with `request` would tee/consume the stream for SSR/serverFns.
  return new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
  });
}

async function fetchStaticAsset(request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }
  if (!isFetcher(env.ASSETS)) {
    return null;
  }

  const pathname = new URL(request.url).pathname;
  // Always synthesize body-free Requests so ASSETS never touches the inbound stream.
  const candidates: Request[] = [withPathname(request, pathname)];

  if (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`)) {
    const stripped = pathname.slice(MOUNT.length) || "/";
    candidates.push(withPathname(request, stripped));
  }

  for (const candidate of candidates) {
    const response = await env.ASSETS.fetch(candidate);
    // Real file or asset-layer redirect. 404/5xx → try next candidate / SSR.
    if (response.status < 400) {
      return response;
    }
  }

  return null;
}

export default createServerEntry({
  async fetch(request, options) {
    const asset = await fetchStaticAsset(request);
    if (asset !== null) {
      return asset;
    }
    return handler.fetch(request, options);
  },
});
