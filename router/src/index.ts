import { Hono, type Handler } from "hono";
import type { Fetcher } from "@cloudflare/workers-types";

export interface Env {
  SYNC_API: Fetcher;
  DOCS_WORKER: Fetcher;
  ADMIN: Fetcher;
}

type App = { Bindings: Env };

const forwardStripped =
  (prefix: string, binding: keyof Env): Handler<App> =>
  async (c) => {
    const url = new URL(c.req.raw.url);
    url.pathname = url.pathname.slice(prefix.length) || "/";
    return c.env[binding].fetch(new Request(url, c.req.raw));
  };

// MangaDex serves a placeholder for any image hotlinked from other domains
// (api.mangadex.org/docs/2-limitations: "you MUST proxy the requests your
// users make to our services"). Proxy covers here so admin <img> tags work.
const UUID_RE = /^[0-9a-f-]{16,64}$/i;
// Original: uuid.jpg|png|gif — thumbnails: uuid.jpg.256.jpg / uuid.jpg.512.jpg
const FILE_RE = /^[0-9a-f-]{16,64}\.(jpg|png|gif)(\.(256|512))?\.jpg$/i;

const mangadexCover: Handler<App> = async (c) => {
  const mangaId = c.req.param("mangaId");
  const filename = c.req.param("filename");
  if (
    mangaId === undefined ||
    filename === undefined ||
    !UUID_RE.test(mangaId) ||
    !FILE_RE.test(filename)
  ) {
    return c.text("Bad cover path", 400);
  }
  const upstream = await fetch(
    `https://uploads.mangadex.org/covers/${mangaId}/${filename}`,
    { headers: { "user-agent": "manifold-router/1.0" } },
  );
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
  headers.set("cache-control", "public, max-age=604800, stale-while-revalidate=86400");
  return new Response(upstream.body, { status: upstream.status, headers });
};

const forwardBinding =
  (binding: keyof Env): Handler<App> =>
  async (c) => c.env[binding].fetch(c.req.raw);

export default new Hono<App>()
  .all("/api", forwardStripped("/api", "SYNC_API"))
  .all("/api/*", forwardStripped("/api", "SYNC_API"))
  .get("/mangadex-cover/:mangaId/:filename", mangadexCover)
  .all("/paperback", forwardStripped("/paperback", "SYNC_API"))
  .all("/paperback/*", forwardStripped("/paperback", "SYNC_API"))
  .all("/admin", forwardBinding("ADMIN"))
  .all("/admin/*", forwardBinding("ADMIN"))
  .all("*", forwardBinding("DOCS_WORKER"));
