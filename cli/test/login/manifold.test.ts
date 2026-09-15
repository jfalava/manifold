/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalFetch:off */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHref, requestInitText } from "@manifold/json";

import {
  createManifoldAuthorization,
  exchangeManifoldCode,
  MANIFOLD_CLI_OAUTH_CLIENT_ID,
  MANIFOLD_CLI_OAUTH_REDIRECT_URI,
} from "../../src/login/manifold";

afterEach(() => {
  vi.unstubAllGlobals();
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
