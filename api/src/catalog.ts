/** Hono / Worker entry — platform async callbacks. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
import { DateTime } from "effect";
import { Hono } from "hono";
import { catalog as trackerCatalog } from "@manifold/tracker/catalog";
import type { Env } from "./types";

const STABLE = "/extensions/0.9/stable";
const REPOSITORY_URL = "https://github.com/jfalava/manifold";
const LICENSE_NAME = "GPL-3.0-or-later";
const MIT_LICENSE_NAME = "MIT";

const extensions = [trackerCatalog] as const;

const byId = (id: string) => extensions.find((entry) => entry.id === id);

const versioningBody = () => ({
  buildTime: DateTime.formatIso(DateTime.nowUnsafe()),
  builtWith: {
    toolchain: "1.0.0-alpha.91",
    types: "1.0.0-alpha.92",
  },
  repository: {
    name: "manifold",
    description: "manifold: canonical registry and tracker",
    url: REPOSITORY_URL,
    source: `${REPOSITORY_URL}/tree/stable`,
    license: `${MIT_LICENSE_NAME} (Manifold) + ${LICENSE_NAME} (derived)`,
  },
  license: LICENSE_NAME,
  licenseUrl: `${STABLE}/LICENSE`,
  mitLicense: MIT_LICENSE_NAME,
  mitLicenseUrl: `${STABLE}/LICENSE-MIT`,
  attributionsUrl: `${STABLE}/ATTRIBUTIONS.md`,
  sources: extensions.map((entry) => ({
    ...entry.info,
    id: entry.id,
  })),
});

const asset = async (env: Env, pathname: string, contentType: string): Promise<Response> => {
  const response = await env.ASSETS.fetch(new Request(`https://assets.local${pathname}`));
  if (!response.ok) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  return new Response(response.body, { status: response.status, headers });
};

const homepage = (): Response => {
  const items = extensions
    .map(
      (entry) =>
        `<li><strong>${entry.info.name}</strong> ${entry.info.version} — ${entry.info.description}</li>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>manifold</title>
</head>
<body>
  <h1>manifold</h1>
  <p>Add this repository in Paperback:</p>
  <p><code>https://manifold.jfa.dev/paperback/extensions/0.9/stable</code></p>
  <p><a href="${STABLE}/LICENSE">GPL license</a> · <a href="${STABLE}/LICENSE-MIT">MIT license</a> · <a href="${STABLE}/ATTRIBUTIONS.md">Attributions</a> · <a href="${REPOSITORY_URL}">Source repository</a></p>
  <ul>${items}</ul>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

export const catalogApp: Hono<{ Bindings: Env }> = new Hono<{ Bindings: Env }>()
  .get(`${STABLE}/versioning.json`, (c) =>
    c.json(versioningBody(), 200, { "cache-control": "no-store" }),
  )
  .get(`${STABLE}/:id/info.json`, (c) => {
    const entry = byId(c.req.param("id"));
    if (!entry) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ ...entry.info, id: entry.id }, 200, { "cache-control": "no-store" });
  })
  .get(`${STABLE}/:id/index.js`, (c) =>
    asset(c.env, `/${c.req.param("id")}/index.js`, "application/javascript"),
  )
  // Paperback 0.9 resolves info.icon as `{id}/static/{icon}` (see inkdex layout).
  .get(`${STABLE}/:id/static/icon.png`, (c) =>
    asset(c.env, `/${c.req.param("id")}/icon.png`, "image/png"),
  )
  .get(`${STABLE}/:id/icon.png`, (c) => asset(c.env, `/${c.req.param("id")}/icon.png`, "image/png"))
  .get(`${STABLE}/LICENSE`, (c) => asset(c.env, "/LICENSE", "text/plain; charset=utf-8"))
  .get(`${STABLE}/LICENSE-MIT`, (c) => asset(c.env, "/LICENSE-MIT", "text/plain; charset=utf-8"))
  .get(`${STABLE}/ATTRIBUTIONS.md`, (c) =>
    asset(c.env, "/ATTRIBUTIONS.md", "text/markdown; charset=utf-8"),
  )
  .get(STABLE, homepage)
  .get(`${STABLE}/`, homepage);
