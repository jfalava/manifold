/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { describe, expect, it } from "vitest";
import { requestHref } from "@manifold/json";
import { catalogApp } from "../src/catalog";
import type { Env } from "../src/types";

const assets = new Map<string, string>([
  ["/LICENSE", "license-text"],
  ["/LICENSE-MIT", "mit-license-text"],
  ["/ATTRIBUTIONS.md", "attributions"],
  [
    "/stable/MANIFOLD/info.json",
    JSON.stringify({
      id: "MANIFOLD",
      name: "MANIFOLD",
      version: "0.1.0-r60",
      description: "stable tracker",
    }),
  ],
  ["/stable/MANIFOLD/index.js", "tracker-bundle"],
  ["/stable/MANIFOLD/icon.png", "png"],
  [
    "/beta/MANIFOLD-beta/info.json",
    JSON.stringify({
      id: "MANIFOLD-beta",
      name: "MANIFOLD beta",
      version: "0.1.0-r60-beta",
      description: "beta tracker",
    }),
  ],
  ["/beta/MANIFOLD-beta/index.js", "tracker-beta-bundle"],
  ["/beta/MANIFOLD-beta/icon.png", "beta-png"],
]);

// SAFETY: test fixture supplies only the Worker Env bindings catalog routes use
const env = {
  ENVIRONMENT: "test",
  ASSETS: {
    fetch: async (input: Request | string) => {
      const pathname = new URL(requestHref(input)).pathname;
      const body = assets.get(pathname);
      if (body === undefined) {
        return new Response("missing", { status: 404 });
      }
      return new Response(body, { status: 200 });
    },
  },
} as Env;

const get = (path: string) => catalogApp.request(`https://manifold.jfa.dev${path}`, {}, env);

describe("Paperback catalog routes", () => {
  it("publishes the stable tracker in versioning.json without auth", async () => {
    const response = await get("/extensions/0.9/stable/versioning.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // SAFETY: parsed JSON matches the trusted/test versioning payload shape
    const body = (await response.json()) as {
      license: string;
      licenseUrl: string;
      mitLicense: string;
      mitLicenseUrl: string;
      attributionsUrl: string;
      sources: readonly { id: string; version: string }[];
    };
    expect(body.license).toBe("GPL-3.0-or-later");
    expect(body.licenseUrl).toBe("/extensions/0.9/stable/LICENSE");
    expect(body.mitLicense).toBe("MIT");
    expect(body.mitLicenseUrl).toBe("/extensions/0.9/stable/LICENSE-MIT");
    expect(body.attributionsUrl).toBe("/extensions/0.9/stable/ATTRIBUTIONS.md");
    expect(body.sources.map((source) => source.id)).toEqual(["MANIFOLD"]);
  });

  it("publishes the beta tracker under the beta channel", async () => {
    const response = await get("/extensions/0.9/beta/versioning.json");
    expect(response.status).toBe(200);
    // SAFETY: parsed JSON matches the trusted/test versioning payload shape
    const body = (await response.json()) as {
      sources: readonly { id: string; name: string }[];
    };
    expect(body.sources.map((source) => source.id)).toEqual(["MANIFOLD-beta"]);
    expect(body.sources[0]?.name).toBe("MANIFOLD beta");
  });

  it("serves the license and attribution notices alongside the catalog", async () => {
    const license = await get("/extensions/0.9/stable/LICENSE");
    expect(license.status).toBe(200);
    expect(license.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await license.text()).toBe("license-text");

    const mitLicense = await get("/extensions/0.9/stable/LICENSE-MIT");
    expect(mitLicense.status).toBe(200);
    expect(mitLicense.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await mitLicense.text()).toBe("mit-license-text");

    const attributions = await get("/extensions/0.9/stable/ATTRIBUTIONS.md");
    expect(attributions.status).toBe(200);
    expect(attributions.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await attributions.text()).toBe("attributions");
  });

  it("serves info.json from staged assets", async () => {
    const response = await get("/extensions/0.9/stable/MANIFOLD/info.json");
    expect(response.status).toBe(200);
    // SAFETY: parsed JSON matches { id: string; name: string } for this trusted/test payload
    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe("MANIFOLD");
    expect(body.name).toBe("MANIFOLD");
  });

  it("serves the staged index.js blob", async () => {
    const response = await get("/extensions/0.9/stable/MANIFOLD/index.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tracker-bundle");
  });

  it("serves beta index.js under the beta path", async () => {
    const response = await get("/extensions/0.9/beta/MANIFOLD-beta/index.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tracker-beta-bundle");
  });

  it("serves icon.png at the Paperback static/ path", async () => {
    const response = await get("/extensions/0.9/stable/MANIFOLD/static/icon.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png");
  });

  it("still serves icon.png at the flat path", async () => {
    const response = await get("/extensions/0.9/stable/MANIFOLD/icon.png");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png");
  });

  it("404s unknown extension ids", async () => {
    const response = await get("/extensions/0.9/stable/Nope/info.json");
    expect(response.status).toBe(404);
  });

  it("404s the beta id on the stable channel", async () => {
    const response = await get("/extensions/0.9/stable/MANIFOLD-beta/info.json");
    expect(response.status).toBe(404);
  });

  it.each(["ManifoldSource", "ManifoldTracker"])("404s removed extension id %s", async (id) => {
    const response = await get(`/extensions/0.9/stable/${id}/info.json`);
    expect(response.status).toBe(404);
  });
});
