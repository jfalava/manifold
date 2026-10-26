/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalFetch:off */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHref, requestInitText } from "@manifold/json";
import { Option } from "effect";

import { apiCall, apiConfig } from "../../src/commands/toolbox";
import {
  createManifoldAuthorization,
  exchangeManifoldCode,
  MANIFOLD_CLI_OAUTH_CLIENT_ID,
  MANIFOLD_CLI_OAUTH_REDIRECT_URI,
} from "../../src/login/manifold";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Manifold CLI OAuth", () => {
  it("creates a loopback PKCE authorization request", async () => {
    const auth = await createManifoldAuthorization("https://manifold.example/api/");
    const url = new URL(auth.url);
    const challenge = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(auth.verifier),
    );
    let binary = "";
    for (const byte of new Uint8Array(challenge)) {
      binary += String.fromCharCode(byte);
    }
    const expectedChallenge = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    expect(url.pathname).toBe("/api/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(MANIFOLD_CLI_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(MANIFOLD_CLI_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe(auth.state);
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a callback code without exposing provider credentials", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestHref(input)).toBe("https://manifold.example/api/v1/oauth/token");
      const body =
        init?.body instanceof URLSearchParams
          ? init.body.toString()
          : (requestInitText(init) ?? "");
      expect(body).not.toContain("github");
      return Response.json({
        access_token: "mf_access_cli",
        refresh_token: "mf_refresh_cli",
        expires_in: 900,
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(
      exchangeManifoldCode("https://manifold.example/api", "mf_code", "verifier"),
    ).resolves.toMatchObject({
      accessToken: "mf_access_cli",
      refreshToken: "mf_refresh_cli",
    });
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(
      body instanceof URLSearchParams
        ? body.toString()
        : requestInitText(fetcher.mock.calls[0]?.[1]),
    ).toContain("client_id=manifold-cli");
  });
});

describe("Manifold API session recovery", () => {
  const origin = "https://manifold.example/api";
  const session = (generation: number, expiresAt = Date.now() + 900_000) => ({
    accessToken: `access-${generation}`,
    refreshToken: `refresh-${generation}`,
    expiresAt,
  });
  const config = () => apiConfig(Option.some(origin), Option.none());

  it.each(["expiry", "401"] as const)(
    "recovers a long-lived config after another config rotates its session: %s",
    async (trigger) => {
      vi.stubEnv("MANIFOLD_TOKEN", "");
      let stored = session(0, trigger === "expiry" ? 0 : Date.now() + 900_000);
      let generation = 0;
      vi.stubGlobal("Bun", {
        secrets: {
          get: async () => JSON.stringify(stored),
          set: async ({ value }: { value: string }) => {
            stored = JSON.parse(value);
          },
        },
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestHref(input).endsWith("/oauth/token")) {
          const grant = new URLSearchParams(
            init?.body instanceof URLSearchParams ? init.body.toString() : requestInitText(init),
          );
          if (grant.get("refresh_token") !== `refresh-${generation}`) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          generation++;
          return Response.json({
            access_token: `access-${generation}`,
            refresh_token: `refresh-${generation}`,
            expires_in: 900,
          });
        }
        return generation > 0 &&
          new Headers(init?.headers).get("authorization") === `Bearer access-${generation}`
          ? Response.json({ linked: "senpai-kanojo" })
          : new Response(null, { status: 401 });
      });
      const first = await config();
      const stale = await config();
      await expect(
        apiCall(first, "/v1/registry/target/providers", "POST", {
          provider: "manganato",
          externalId: "senpai-kanojo",
        }),
      ).resolves.toEqual({ linked: "senpai-kanojo" });
      await expect(
        apiCall(stale, "/v1/registry/target/providers", "POST", {
          provider: "manganato",
          externalId: "senpai-kanojo",
        }),
      ).resolves.toEqual({ linked: "senpai-kanojo" });
      expect(generation).toBe(1);

      // The adopted refresh token must also survive the next rotation.
      stale.accessExpiresAt = 0;
      await expect(apiCall(stale, "/v1/registry")).resolves.toEqual({ linked: "senpai-kanojo" });
      expect(generation).toBe(2);
    },
  );

  it("refreshes a changed stored session when its access token is also expired", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    let stored = session(0, 0);
    vi.stubGlobal("Bun", {
      secrets: {
        get: async () => JSON.stringify(stored),
        set: async ({ value }: { value: string }) => {
          stored = JSON.parse(value);
        },
      },
    });
    const stale = await config();
    stored = session(1, 0);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).endsWith("/oauth/token")) {
        if (
          !(init?.body instanceof URLSearchParams) ||
          init.body.get("refresh_token") !== "refresh-1"
        ) {
          return new Response(null, { status: 400 });
        }
        return Response.json({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 900,
        });
      }
      return new Headers(init?.headers).get("authorization") === "Bearer access-2"
        ? Response.json({ recovered: true })
        : new Response(null, { status: 401 });
    });
    await expect(apiCall(stale, "/v1/registry")).resolves.toEqual({ recovered: true });
    expect(stored.refreshToken).toBe("refresh-2");
  });

  it("stops after one rejected API replay with a changed stored session", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    let stored = session(0);
    vi.stubGlobal("Bun", { secrets: { get: async () => JSON.stringify(stored) } });
    const stale = await config();
    stored = session(1);
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    });
    await expect(apiCall(stale, "/v1/registry")).rejects.toThrow("Unauthorized");
    expect(requests).toBe(2);
  });

  it("recovers a rotation between reading storage and attempting refresh", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    let stored = session(0, 0);
    vi.stubGlobal("Bun", { secrets: { get: async () => JSON.stringify(stored) } });
    let refreshes = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).endsWith("/oauth/token")) {
        refreshes++;
        stored = session(1);
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return new Headers(init?.headers).get("authorization") === "Bearer access-1"
        ? Response.json({ recovered: true })
        : new Response(null, { status: 401 });
    });
    await expect(apiCall(await config(), "/v1/registry")).resolves.toEqual({ recovered: true });
    expect(refreshes).toBe(1);
  });

  it("does not retry a rejected refresh token when storage has not changed", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    vi.stubGlobal("Bun", { secrets: { get: async () => JSON.stringify(session(0, 0)) } });
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    await expect(apiCall(await config(), "/v1/registry")).rejects.toThrow(
      "Manifold OAuth refresh failed: HTTP 400",
    );
    expect(requests).toBe(1);
  });

  it.each(["flag", "environment"] as const)(
    "keeps explicit %s tokens separate from stored sessions",
    async (source) => {
      vi.stubEnv("MANIFOLD_TOKEN", source === "environment" ? "explicit-token" : "");
      vi.stubGlobal("Bun", {
        secrets: {
          get: async () => {
            throw new Error("Explicit tokens must not use the keychain");
          },
        },
      });
      let requests = 0;
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests++;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-token");
        return Response.json({ error: "Unauthorized explicit token" }, { status: 401 });
      });
      const explicit = await apiConfig(
        Option.some(origin),
        source === "flag" ? Option.some("explicit-token") : Option.none(),
      );
      await expect(apiCall(explicit, "/v1/registry")).rejects.toThrow(
        "Unauthorized explicit token",
      );
      expect(requests).toBe(1);
    },
  );
});
