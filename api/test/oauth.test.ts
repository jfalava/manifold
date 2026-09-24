/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT,
} from "@manifold/mangadex";
import {
  adminOAuthReturnPath,
  anilistDeviceRedirectUri,
  isPublicOAuthRoute,
  oauthRedirectUri,
  publicSiteOrigin,
} from "../src/http";
import { createAuthorizationUrl, getOAuthClientConfig } from "../src/oauth";
import { handleOAuth } from "../src/routes/oauth";
import type { Env, ManifoldSyncStub } from "../src/types";

const environment = {
  MANIFOLD_ANILIST_CLIENT_ID: "anilist-client",
  MANIFOLD_ANILIST_CLIENT_SECRET: "anilist-secret",
  MANIFOLD_MAL_CLIENT_ID: "mal-client",
  MANIFOLD_MAL_CLIENT_SECRET: "",
};

describe("OAuth provider configuration", () => {
  it("builds public callback and device URLs behind the /api router mount", () => {
    const bareOrigin = { MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://example.test/" };
    const apiOrigin = { MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://example.test/api/" };

    expect(oauthRedirectUri("mal", bareOrigin)).toBe(
      "https://example.test/api/v1/auth/mal/callback",
    );
    expect(anilistDeviceRedirectUri(bareOrigin)).toBe(
      "https://example.test/api/v1/auth/anilist/device",
    );
    expect(anilistDeviceRedirectUri(apiOrigin)).toBe(
      "https://example.test/api/v1/auth/anilist/device",
    );
  });

  it("only bypasses bearer auth for exact GET OAuth routes", () => {
    expect(isPublicOAuthRoute("GET", ["v1", "auth", "anilist", "callback"])).toBe(true);
    expect(isPublicOAuthRoute("GET", ["v1", "auth", "mal", "callback"])).toBe(true);
    expect(isPublicOAuthRoute("GET", ["v1", "auth", "anilist", "device"])).toBe(true);
    expect(isPublicOAuthRoute("GET", ["v1", "oauth", "authorize"])).toBe(true);
    expect(isPublicOAuthRoute("GET", ["v1", "oauth", "github", "callback"])).toBe(true);
    expect(isPublicOAuthRoute("POST", ["v1", "oauth", "token"])).toBe(true);
    expect(isPublicOAuthRoute("POST", ["v1", "auth", "anilist", "callback"])).toBe(false);
    expect(isPublicOAuthRoute("GET", ["v1", "oauth", "token"])).toBe(false);
    expect(isPublicOAuthRoute("POST", ["v1", "oauth", "authorize"])).toBe(false);
    expect(isPublicOAuthRoute("GET", ["other", "path", "anilist", "device"])).toBe(false);
  });

  it("accepts only same-origin admin return paths after OAuth", () => {
    expect(adminOAuthReturnPath("/admin/credentials")).toBe("/admin/credentials");
    expect(adminOAuthReturnPath("/admin/credentials?x=1")).toBe("/admin/credentials?x=1");
    expect(adminOAuthReturnPath("//evil.example")).toBeUndefined();
    expect(adminOAuthReturnPath("https://evil.example/admin")).toBeUndefined();
    expect(adminOAuthReturnPath("/api/v1/auth")).toBeUndefined();
    expect(adminOAuthReturnPath(null)).toBeUndefined();
  });

  it("derives the public site origin from the OAuth redirect base", () => {
    expect(publicSiteOrigin({ MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://example.test/" })).toBe(
      "https://example.test",
    );
    expect(publicSiteOrigin({ MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://example.test/api" })).toBe(
      "https://example.test",
    );
  });

  it("creates the MAL callback URL with its supported plain PKCE method", async () => {
    const url = createAuthorizationUrl(
      await getOAuthClientConfig("mal", environment),
      "https://example.test/v1/auth/mal/callback",
      "state-value",
      "verifier-value",
    );

    expect(url).toContain("code_challenge=verifier-value");
    expect(url).toContain("code_challenge_method=plain");
    expect(url).not.toContain("mal-secret");
  });

  it("does not add PKCE parameters to AniList", async () => {
    const url = createAuthorizationUrl(
      await getOAuthClientConfig("anilist", environment),
      "https://example.test/v1/auth/anilist/callback",
      "state-value",
    );

    expect(url).not.toContain("code_challenge");
    expect(url).not.toContain("anilist-secret");
  });

  it("creates the MangaDex personal-client password grant", () => {
    const form = createMangaDexPasswordGrant({
      clientId: "personal-client-id",
      clientSecret: "personal-client-secret",
      username: "manga-user",
      password: "manga-password",
    });

    expect(MANGADEX_TOKEN_ENDPOINT).toBe(
      "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token",
    );
    expect(form.get("grant_type")).toBe("password");
    expect(form.get("username")).toBe("manga-user");
    expect(form.get("password")).toBe("manga-password");
    expect(form.get("client_id")).toBe("personal-client-id");
    expect(form.get("client_secret")).toBe("personal-client-secret");
  });

  it("creates the MangaDex refresh grant without username credentials", () => {
    const form = createMangaDexRefreshGrant(
      { clientId: "personal-client-id", clientSecret: "personal-client-secret" },
      "refresh-token",
    );

    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-token");
    expect(form.get("username")).toBeNull();
    expect(form.get("password")).toBeNull();
  });
});

describe("Manifold GitHub OAuth callback", () => {
  const callbackResponse = async (completeResult: {
    readonly redirectUri: string;
    readonly state: string;
    readonly error?: string;
    readonly accountMismatch?: boolean;
  }): Promise<Response> => {
    const url = new URL("https://manifold.example/v1/oauth/github/callback?state=callback-state");
    const callbackStub: Pick<ManifoldSyncStub, "completeGithubOAuth"> = {
      completeGithubOAuth: async () => completeResult,
    };
    // SAFETY: this callback route only calls completeGithubOAuth on the stub.
    const sync = callbackStub as ManifoldSyncStub;
    const env = {
      // SAFETY: the route only reads MANIFOLD_SYNC on this callback path.
      ...({} as Env),
      MANIFOLD_SYNC: {
        getByName: () => sync,
      },
    } satisfies Env;
    const response = await Effect.runPromise(
      handleOAuth({
        request: new Request(url),
        env,
        url,
        path: ["v1", "oauth", "github", "callback"],
      }),
    );
    if (!response) {
      throw new Error("GitHub OAuth callback returned no response");
    }
    return response;
  };

  it("explains a rejected Paperback GitHub account in the browser callback", async () => {
    const response = await callbackResponse({
      redirectUri: "paperback://manifold-login?error=access_denied&state=callback-state",
      state: "callback-state",
      error: "access_denied",
      accountMismatch: true,
    });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain("GitHub account not authorized");
    expect(body).toContain("Switch to the configured GitHub account in your browser");
    expect(body).not.toContain("callback-state");
    expect(body).not.toContain("access_token");
  });

  it("keeps ordinary GitHub denial on the OAuth redirect", async () => {
    const response = await callbackResponse({
      redirectUri: "paperback://manifold-login?error=access_denied&state=callback-state",
      state: "callback-state",
      error: "access_denied",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "paperback://manifold-login?error=access_denied&state=callback-state",
    );
  });
});
