import { describe, expect, it } from "vitest";
import { catalogApp } from "../src/catalog";
import type { Env } from "../src/types";

const assets = new Map<string, string>([
  ["/ManifoldSource/index.js", "source-bundle"],
  ["/ManifoldTracker/index.js", "tracker-bundle"],
  ["/ManifoldSource/icon.png", "png"],
]);

// SAFETY: test fixture supplies only the Worker Env bindings catalog routes use
const env = {
  ENVIRONMENT: "test",
  ASSETS: {
    fetch: async (input: Request | string) => {
      const pathname = new URL(typeof input === "string" ? input : input.url).pathname;
      const body = assets.get(pathname);
      if (body === undefined) {return new Response("missing", { status: 404 });}
      return new Response(body, { status: 200 });
    },
  },
} as Env;

const get = (path: string) =>
  catalogApp.request(`https://manifold.jfa.dev${path}`, {}, env);

describe("Paperback catalog routes", () => {
  it("unions source and tracker into versioning.json without auth", async () => {
    const response = await get("/extensions/0.9/stable/versioning.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // SAFETY: parsed JSON matches { sources: readonly { id: string; version: string }[]; } for this trusted/test payload
    const body = (await response.json()) as {
      sources: readonly { id: string; version: string }[];
    };
    expect(body.sources.map((source) => source.id)).toEqual([
      "ManifoldSource",
      "ManifoldTracker",
    ]);
  });

  it("serves info.json from pbconfig", async () => {
    const response = await get("/extensions/0.9/stable/ManifoldSource/info.json");
    expect(response.status).toBe(200);
    // SAFETY: parsed JSON matches { id: string; name: string } for this trusted/test payload
    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe("ManifoldSource");
    expect(body.name).toBe("manifold: source");
  });

  it("serves the staged index.js blob", async () => {
    const response = await get("/extensions/0.9/stable/ManifoldSource/index.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("source-bundle");
  });

  it("404s unknown extension ids", async () => {
    const response = await get("/extensions/0.9/stable/Nope/info.json");
    expect(response.status).toBe(404);
  });
});
