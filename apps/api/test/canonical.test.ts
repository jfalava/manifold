import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ai, VectorizeIndex } from "@cloudflare/workers-types";
import { searchCanonical } from "../src/canonical";
import type { Env } from "../src/types";

const environment = (): Env => ({
  // SAFETY: test/double or boundary cast through unknown to Ai
  AI: { run: async () => ({ data: [] }) } as unknown as Ai,
  // SAFETY: value matches unknown as VectorizeIndex at this call site
  MANGADEX_INDEX: {
    query: async () => ({ matches: [], count: 0 }),
    upsert: async () => ({ mutationId: "test" }),
  } as unknown as VectorizeIndex,
  MANIFOLD_SYNC: {
    getByName: () => {
      throw new Error("ManifoldSync is not used by canonical search");
    },
  },
  ASSETS: {
    fetch: async () => new Response("not used", { status: 404 }),
  },
  ENVIRONMENT: "test",
  MANIFOLD_TOKEN: "token",
  OAUTH_REDIRECT_BASE_URL: "https://example.test",
  OAUTH_TOKEN_ENCRYPTION_SECRET: "encryption-secret",
  ANILIST_CLIENT_ID: "anilist-client",
  ANILIST_CLIENT_SECRET: "anilist-secret",
  MAL_CLIENT_ID: "not-configured",
  MAL_CLIENT_SECRET: "",
  MANGADEX_CLIENT_ID: "mangadex-client",
  MANGADEX_CLIENT_SECRET: "mangadex-secret",
  MANGADEX_USERNAME: "manga-user",
  MANGADEX_PASSWORD: "manga-password",
});

const anilistBody = {
  data: {
    Page: {
      media: [
        {
          id: 100,
          title: { romaji: "Canonical Example", userPreferred: "Canonical Example" },
          synonyms: ["Example"],
          averageScore: 80,
        },
      ],
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("personal canonical search", () => {
  it("returns AniList results and a partial MAL warning when MAL is unconfigured", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(anilistBody), {
        headers: { "content-type": "application/json" },
      })
    );

    const body = await searchCanonical(environment(), "example", "all", 3);

    expect(body.results[0]?.id).toBe("anilist:100");
    const anilistProvider = body.providers.find((p) => p.provider === "anilist");
    const malProvider = body.providers.find((p) => p.provider === "mal");
    // SAFETY: test/double or boundary cast through unknown to unknown[]
    expect(anilistProvider?.results).toEqual(expect.any(Array) as unknown[]);
    expect(malProvider).toEqual({
      provider: "mal",
      results: [],
      error: { message: "MyAnimeList client id is not configured" },
    });
  });

  it("returns a provider error when only an unavailable provider is requested", async () => {
    const body = await searchCanonical(environment(), "example", "mal", 20);

    expect(body).toMatchObject({
      providers: [
        {
          provider: "mal",
          error: { message: "MyAnimeList client id is not configured" },
        },
      ],
    });
  });
});
