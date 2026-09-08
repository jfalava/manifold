import { describe, expect, it } from "vitest";
import { requestHref } from "@manifold/json";
import { catalogApp } from "../src/catalog";
import type { Env } from "../src/types";

const assets = new Map<string, string>([
  ["/MANIFOLD/index.js", "tracker-bundle"],
  ["/MANIFOLD/icon.png", "png"],
]);

// SAFETY: test fixture supplies only the Worker Env bindings catalog routes use
const env = {
  ENVIRONMENT: "test",
  ASSETS: {
    fetch: async (input: Request | string) => {
      const pathname = new URL(requestHref(input)).pathname;
      const body = assets.get(pathname);
      if (body === undefined) {return new Response("missing", { status: 404 });}
      return new Response(body, { status: 200 });
    },
  },
} as Env;

const get = (path: string) =>
  catalogApp.request(`https://manifold.jfa.dev${path}`, {}, env);

describe("Paperback catalog routes", () => {
  it("publishes only the tracker in versioning.json without auth", async () => {
    const response = await get("/extensions/0.9/stable/versioning.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // SAFETY: parsed JSON matches { sources: readonly { id: string; version: string }[]; } for this trusted/test payload
    const body = (await response.json()) as {
      sources: readonly { id: string; version: string }[];
    };
    expect(body.sources.map((source) => source.id)).toEqual(["MANIFOLD"]);
  });

  it("serves info.json from pbconfig", async () => {
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

  it("serves icon.png at the Paperback static/ path", async () => {
    const response = await get(
      "/extensions/0.9/stable/MANIFOLD/static/icon.png",
    );
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

  it.each(["ManifoldSource", "ManifoldTracker"])("404s removed extension id %s", async (id) => {
    const response = await get(`/extensions/0.9/stable/${id}/info.json`);
    expect(response.status).toBe(404);
  });
});
