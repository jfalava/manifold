/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { requestHref, requestInitText } from "@manifold/json";
import type { RegistryEntry } from "@manifold/contract";
import { getRegistryCanonical, searchCanonical } from "../src/canonical";
import { handleCanonical } from "../src/routes/canonical";
import type { Env } from "../src/types";

/**
 * Cloudflare Ai / VectorizeIndex are branded platform types; test doubles only
 * implement the methods searchCanonical calls. TypeScript rejects a direct
 * Env assertion for that mismatch, so we bridge via a typed helper.
 */
const environment = (clientId = "not-configured"): Env => {
  const emptyEmbeddings: number[][] = [];
  const emptyMatches: never[] = [];
  const fixture = {
    AI: { run: async () => ({ data: emptyEmbeddings }) },
    MANGADEX_INDEX: {
      query: async () => ({ matches: emptyMatches, count: 0 }),
      upsert: async () => ({ mutationId: "test" }),
    },
    MANIFOLD_SYNC: {
      getByName: (): never => {
        throw new Error("ManifoldSync is not used by canonical search");
      },
    },
    ASSETS: {
      fetch: async () => new Response("not used", { status: 404 }),
    },
    ENVIRONMENT: "test",
    MANIFOLD_TOKEN: "token",
    MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://example.test",
    MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: "encryption-secret",
    MANIFOLD_ANILIST_CLIENT_ID: "anilist-client",
    MANIFOLD_ANILIST_CLIENT_SECRET: "anilist-secret",
    MANIFOLD_MAL_CLIENT_ID: clientId,
    MANIFOLD_MAL_CLIENT_SECRET: "",
    MANIFOLD_MANGADEX_CLIENT_ID: "mangadex-client",
    MANIFOLD_MANGADEX_CLIENT_SECRET: "mangadex-secret",
    MANIFOLD_MANGADEX_USERNAME: "manga-user",
    MANIFOLD_MANGADEX_PASSWORD: "manga-password",
  };
  // SAFETY: fixture implements the Env surface searchCanonical reads
  // @ts-expect-error Ai/VectorizeIndex platform brands are wider than test doubles
  return fixture;
};

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
  vi.restoreAllMocks();
});

describe("personal canonical search", () => {
  it("returns AniList results and a partial MAL warning when MAL is unconfigured", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(anilistBody), {
          headers: { "content-type": "application/json" },
        }),
    );

    const body = await searchCanonical(environment(), "example", "all", 3);

    expect(body.results[0]?.id).toBe("anilist:100");
    const anilistProvider = body.providers.find((p) => p.provider === "anilist");
    const malProvider = body.providers.find((p) => p.provider === "mal");
    expect(anilistProvider?.results).toEqual(expect.any(Array));
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

  it.each([401, 403, 408, 429, 500, 503])(
    "falls back on AniList HTTP %s and retains diagnostics",
    async (status) => {
      const requests: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = requestHref(input);
        requests.push(href);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (href.includes("anilist.co")) {
          return new Response("Blocked", { status });
        }
        expect(new Headers(init?.headers).get("X-MAL-CLIENT-ID")).toBe("client");
        return Response.json({ data: [{ node: { id: 77, title: "Example Manga" } }] });
      });
      const result = await searchCanonical(environment("client"), "example", "auto", 3);
      expect(result.results.map((hit) => hit.id)).toEqual(["mal:77"]);
      expect(result.providers[0]?.provider).toBe("anilist");
      expect(result.providers[0]?.error?.status).toBe(status);
      expect(result.providers[0]?.error?.message).toContain("Blocked");
      expect(result.providers[1]?.provider).toBe("mal");
      expect(result.providers[1]?.results[0]?.providerId).toBe("77");
      expect(requests).toHaveLength(2);
    },
  );

  it.each([400, 404, 422])(
    "does not hide AniList HTTP %s with automatic fallback",
    async (status) => {
      const fetcher = vi.fn(async () => new Response("Invalid request", { status }));
      vi.stubGlobal("fetch", fetcher);
      const result = await searchCanonical(environment("client"), "example", "auto", 3);
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0]?.error?.status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([anilistBody, { data: { Page: { media: [] } } }])(
    "does not call MAL on a successful AniList response",
    async (body) => {
      const fetcher = vi.fn(async () => Response.json(body));
      vi.stubGlobal("fetch", fetcher);
      const result = await searchCanonical(environment("client"), "example", "auto", 3);
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0]?.error).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["network", "timeout", "non-json", "malformed", "graphql"])(
    "falls back on %s failure",
    async (failure) => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (!requestHref(input).includes("anilist.co")) {
          return Response.json({ data: [{ node: { id: 77, title: "Example" } }] });
        }
        if (failure === "network") {
          throw new TypeError("Network unavailable");
        }
        if (failure === "timeout") {
          throw new DOMException("Timed out", "TimeoutError");
        }
        if (failure === "non-json") {
          return new Response("<html>Blocked</html>");
        }
        if (failure === "graphql") {
          return Response.json({ errors: [{ message: "Blocked", status: 403 }] });
        }
        return Response.json({ data: null });
      });
      const result = await searchCanonical(environment("client"), "example", "auto", 3);
      expect(result.results[0]?.id).toBe("mal:77");
      expect(result.providers[0]?.error).toBeDefined();
      if (failure === "graphql") {
        expect(result.providers[0]?.error?.status).toBe(403);
      }
    },
  );

  it("aborts a hung AniList request before attempting MAL", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      expect(delay).toBe(5_000);
      const signal = AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
      signals.push(signal);
      return signal;
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).includes("anilist.co")) {
        init?.signal?.throwIfAborted();
      }
      return Response.json({ data: [] });
    });
    const result = await searchCanonical(environment("client"), "example", "auto", 3);
    expect(result.providers.map((provider) => provider.provider)).toEqual(["anilist", "mal"]);
    expect(signals).toHaveLength(2);
  });

  it("keeps an explicit AniList search strict", async () => {
    const fetcher = vi.fn(async () => new Response("Blocked", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await searchCanonical(environment("client"), "example", "anilist", 3);
    expect(result.providers).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([200, 503])(
    "defaults the route to auto and returns the correct status when MAL returns %s",
    async (malStatus) => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
        requestHref(input).includes("anilist.co")
          ? new Response("Blocked", { status: 403 })
          : Response.json({ data: [] }, { status: malStatus }),
      );
      const url = new URL("https://example.test/v1/canonical/search?q=example");
      const response = await Effect.runPromise(
        handleCanonical({
          url,
          request: new Request(url),
          path: ["v1", "canonical", "search"],
          env: environment("client"),
        }),
      );
      expect(response?.status).toBe(malStatus === 200 ? 200 : 502);
      expect(await response?.json()).toMatchObject({
        providers: [{ provider: "anilist", error: { status: 403 } }, { provider: "mal" }],
      });
    },
  );
});

const registryEntry: RegistryEntry = {
  id: "a998f88c-1a5d-46a8-81b7-a3ac92021598",
  provider: "anilist",
  providerId: "42",
  title: "Stored title",
  createdAt: 1,
  updatedAt: 2,
  providers: [
    { provider: "anilist", externalId: "42", updatedAt: 2 },
    { provider: "mal", externalId: "77", updatedAt: 2 },
  ],
};

describe("registry metadata fallback", () => {
  it("uses the linked MAL id and retains the UUID across outage and recovery", async () => {
    let blocked = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).includes("anilist.co")) {
        expect(JSON.parse(requestInitText(init) ?? "")).toMatchObject({ variables: { id: 42 } });
        return blocked
          ? new Response("Blocked", { status: 403 })
          : Response.json({
              data: { Media: { id: 42, idMal: 77, title: { romaji: "AniList title" } } },
            });
      }
      expect(requestHref(input)).toContain("/manga/77?");
      return Response.json({ id: 77, title: "MAL title", synopsis: "Fallback description" });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await getRegistryCanonical(environment("client"), registryEntry)).toMatchObject({
      id: registryEntry.id,
      provider: "mal",
      providerId: "77",
      metadata: { description: "Fallback description" },
    });
    blocked = false;
    expect(await getRegistryCanonical(environment("client"), registryEntry)).toMatchObject({
      id: registryEntry.id,
      provider: "anilist",
      providerId: "42",
      title: "AniList title",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reads MAL-only entries without calling AniList", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(requestHref(input)).toContain("/manga/77?");
      return Response.json({ id: 77, title: "MAL title" });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await getRegistryCanonical(environment("client"), {
      ...registryEntry,
      provider: "mal",
      providerId: "77",
      providers: registryEntry.providers.slice(1),
    });
    expect(result).toMatchObject({ id: registryEntry.id, provider: "mal", providerId: "77" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "returns registry data when providers fail, with MAL link=%s",
    async (hasMal) => {
      const fetcher = vi.fn(async () => new Response("Unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetcher);
      const result = await getRegistryCanonical(environment("client"), {
        ...registryEntry,
        providers: hasMal ? registryEntry.providers : registryEntry.providers.slice(0, 1),
      });
      expect(result).toEqual({
        id: registryEntry.id,
        provider: "anilist",
        providerId: "42",
        title: "Stored title",
        aliases: [],
      });
      expect(fetcher).toHaveBeenCalledTimes(hasMal ? 2 : 1);
    },
  );
});
