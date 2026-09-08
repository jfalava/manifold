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
  const upstream = await fetch(`https://uploads.mangadex.org/covers/${mangaId}/${filename}`, {
    headers: { "user-agent": "manifold/0.1 (+https://manifold.jfa.dev; manifold/router)" },
  });
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "image/jpeg");
  headers.set("cache-control", "public, max-age=604800, stale-while-revalidate=86400");
  return new Response(upstream.body, { status: upstream.status, headers });
};

const forwardBinding =
  (binding: keyof Env): Handler<App> =>
  async (c) =>
    c.env[binding].fetch(c.req.raw);

/**
 * Explicit docs allowlist (same idea as jfa.dev's router mounts).
 * Unknown paths return 418 before any service-binding hop so bots do not
 * burn docs-worker compute on wp-admin / wordpress probes.
 *
 * Keep in sync with docs content top-level sections + static build outputs.
 */
const DOCS_EXACT_PATHS = new Set([
  "/",
  "/index.md",
  "/index.mdx",
  "/404",
  "/404.html",
  "/llms.txt",
  "/llms-full.txt",
  "/robots.txt",
  "/og.png",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/site.webmanifest",
  "/sitemap-0.xml",
  "/sitemap-index.xml",
]);

/** Prefixes that own a whole docs subtree. */
const DOCS_PREFIXES = [
  "/architecture",
  "/auth",
  "/cli",
  "/development",
  "/install",
  "/og",
  "/_astro",
  "/_nimbus",
  "/pagefind",
  "/fonts",
] as const;

export function isDocsPath(pathname: string): boolean {
  if (DOCS_EXACT_PATHS.has(pathname)) {
    return true;
  }

  for (const prefix of DOCS_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  return false;
}

const forwardDocs: Handler<App> = async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (!isDocsPath(pathname)) {
    return c.text("I'm a teapot", 418);
  }
  return c.env.DOCS_WORKER.fetch(c.req.raw);
};

export default new Hono<App>()
  .all("/api", forwardStripped("/api", "SYNC_API"))
  .all("/api/*", forwardStripped("/api", "SYNC_API"))
  .get("/mangadex-cover/:mangaId/:filename", mangadexCover)
  .all("/paperback", forwardStripped("/paperback", "SYNC_API"))
  .all("/paperback/*", forwardStripped("/paperback", "SYNC_API"))
  .all("/admin", forwardBinding("ADMIN"))
  .all("/admin/*", forwardBinding("ADMIN"))
  .all("*", forwardDocs);
