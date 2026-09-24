/** Hono / Worker entry — platform async callbacks. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
import { DateTime, Schema } from "effect";
import { Hono } from "hono";
import type { Env } from "./types";

const STABLE = "/extensions/0.9/stable";
const BETA = "/extensions/0.9/beta";
const REPOSITORY_URL = "https://github.com/jfalava/manifold";
const LICENSE_NAME = "GPL-3.0-or-later";
const MIT_LICENSE_NAME = "MIT";

const catalogs = [
  { basePath: STABLE, assetPath: "stable", extensionId: "MANIFOLD" },
  { basePath: BETA, assetPath: "beta", extensionId: "MANIFOLD-beta" },
] as const;

type Catalog = (typeof catalogs)[number];

const ExtensionInfoBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  contentRating: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  developers: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String })),
  ),
  badges: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        textColor: Schema.String,
        backgroundColor: Schema.String,
      }),
    ),
  ),
  capabilities: Schema.optional(Schema.Array(Schema.Finite)),
});

type ExtensionInfoBody = Schema.Schema.Type<typeof ExtensionInfoBody>;

const asset = async (env: Env, pathname: string, contentType: string): Promise<Response> => {
  const response = await env.ASSETS.fetch(new Request(`https://assets.local${pathname}`));
  if (!response.ok) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const headers = new Headers(response.headers);
  headers.set("content-type", contentType);
  return new Response(response.body, { status: response.status, headers });
};

const readExtensionInfo = async (
  env: Env,
  catalog: Catalog,
): Promise<ExtensionInfoBody | undefined> => {
  const response = await env.ASSETS.fetch(
    new Request(`https://assets.local/${catalog.assetPath}/${catalog.extensionId}/info.json`),
  );
  if (!response.ok) {
    return undefined;
  }

  try {
    const raw: unknown = await response.json();
    return Schema.decodeUnknownOption(ExtensionInfoBody)(raw).pipe(
      (option) => (option._tag === "Some" ? option.value : undefined),
    );
  } catch {
    return undefined;
  }
};

const versioningBody = async (env: Env, catalog: Catalog) => {
  const info = await readExtensionInfo(env, catalog);
  const sources =
    info === undefined
      ? []
      : [
          {
            ...info,
            id: catalog.extensionId,
          },
        ];

  return {
    buildTime: DateTime.formatIso(DateTime.nowUnsafe()),
    builtWith: {
      toolchain: "1.0.0-alpha.91",
      types: "1.0.0-alpha.92",
    },
    repository: {
      name: "manifold",
      description: "manifold: canonical registry and tracker",
      url: REPOSITORY_URL,
      source: `${REPOSITORY_URL}/tree/${catalog.assetPath}`,
      license: `${MIT_LICENSE_NAME} (Manifold) + ${LICENSE_NAME} (derived)`,
    },
    license: LICENSE_NAME,
    licenseUrl: `${catalog.basePath}/LICENSE`,
    mitLicense: MIT_LICENSE_NAME,
    mitLicenseUrl: `${catalog.basePath}/LICENSE-MIT`,
    attributionsUrl: `${catalog.basePath}/ATTRIBUTIONS.md`,
    sources,
  };
};

const homepage = async (env: Env, catalog: Catalog): Promise<Response> => {
  const info = await readExtensionInfo(env, catalog);
  const items =
    info === undefined
      ? "<li><em>No extension staged for this channel yet.</em></li>"
      : `<li><strong>${String(info.name ?? catalog.extensionId)}</strong> ${String(info.version ?? "")} — ${String(info.description ?? "")}</li>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>manifold</title>
</head>
<body>
  <h1>manifold (${catalog.assetPath})</h1>
  <p>Add this repository in Paperback:</p>
  <p><code>https://manifold.jfa.dev/paperback${catalog.basePath}</code></p>
  <p><a href="${catalog.basePath}/LICENSE">GPL license</a> · <a href="${catalog.basePath}/LICENSE-MIT">MIT license</a> · <a href="${catalog.basePath}/ATTRIBUTIONS.md">Attributions</a> · <a href="${REPOSITORY_URL}">Source repository</a></p>
  <ul>${items}</ul>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

const addCatalogRoutes = (app: Hono<{ Bindings: Env }>, catalog: Catalog): void => {
  app
    .get(`${catalog.basePath}/versioning.json`, async (c) =>
      c.json(await versioningBody(c.env, catalog), 200, { "cache-control": "no-store" }),
    )
    .get(`${catalog.basePath}/:id/info.json`, async (c) => {
      const id = c.req.param("id");
      if (id !== catalog.extensionId) {
        return c.json({ error: "Not found" }, 404);
      }
      const info = await readExtensionInfo(c.env, catalog);
      if (info === undefined) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ ...info, id: catalog.extensionId }, 200, { "cache-control": "no-store" });
    })
    .get(`${catalog.basePath}/:id/index.js`, (c) =>
      asset(
        c.env,
        `/${catalog.assetPath}/${c.req.param("id")}/index.js`,
        "application/javascript",
      ),
    )
    // Paperback 0.9 resolves info.icon as `{id}/static/{icon}` (see inkdex layout).
    .get(`${catalog.basePath}/:id/static/icon.png`, (c) =>
      asset(c.env, `/${catalog.assetPath}/${c.req.param("id")}/icon.png`, "image/png"),
    )
    .get(`${catalog.basePath}/:id/icon.png`, (c) =>
      asset(c.env, `/${catalog.assetPath}/${c.req.param("id")}/icon.png`, "image/png"),
    )
    .get(`${catalog.basePath}/LICENSE`, (c) =>
      asset(c.env, "/LICENSE", "text/plain; charset=utf-8"),
    )
    .get(`${catalog.basePath}/LICENSE-MIT`, (c) =>
      asset(c.env, "/LICENSE-MIT", "text/plain; charset=utf-8"),
    )
    .get(`${catalog.basePath}/ATTRIBUTIONS.md`, (c) =>
      asset(c.env, "/ATTRIBUTIONS.md", "text/markdown; charset=utf-8"),
    )
    .get(catalog.basePath, (c) => homepage(c.env, catalog))
    .get(`${catalog.basePath}/`, (c) => homepage(c.env, catalog));
};

export const catalogApp: Hono<{ Bindings: Env }> = new Hono<{ Bindings: Env }>();

for (const catalog of catalogs) {
  addCatalogRoutes(catalogApp, catalog);
}
