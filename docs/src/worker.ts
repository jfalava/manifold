/** Docs site browser/Worker host (Astro + client scripts). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
export interface Env {
  DOCS_ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.DOCS_ASSETS.fetch(new Request(request));
    const pathname = new URL(request.url).pathname;
    if (!pathname.endsWith("/versioning.json")) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};
