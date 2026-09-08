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
    expect(isPublicOAuthRoute("POST", ["v1", "auth", "anilist", "callback"])).toBe(false);
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
