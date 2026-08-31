import { describe, expect, it } from "vitest";
import {
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT
} from "@manifold/mangadex";
import { createAuthorizationUrl, getOAuthClientConfig } from "../src/oauth";

const environment = {
  ANILIST_CLIENT_ID: "anilist-client",
  ANILIST_CLIENT_SECRET: "anilist-secret",
  MAL_CLIENT_ID: "mal-client",
  MAL_CLIENT_SECRET: ""
};

describe("OAuth provider configuration", () => {
  it("creates the MAL callback URL with its supported plain PKCE method", async () => {
    const url = createAuthorizationUrl(
      await getOAuthClientConfig("mal", environment),
      "https://example.test/v1/auth/mal/callback",
      "state-value",
      "verifier-value"
    );

    expect(url).toContain("code_challenge=verifier-value");
    expect(url).toContain("code_challenge_method=plain");
    expect(url).not.toContain("mal-secret");
  });

  it("does not add PKCE parameters to AniList", async () => {
    const url = createAuthorizationUrl(
      await getOAuthClientConfig("anilist", environment),
      "https://example.test/v1/auth/anilist/callback",
      "state-value"
    );

    expect(url).not.toContain("code_challenge");
    expect(url).not.toContain("anilist-secret");
  });

  it("creates the MangaDex personal-client password grant", () => {
    const form = createMangaDexPasswordGrant({
      clientId: "personal-client-id",
      clientSecret: "personal-client-secret",
      username: "manga-user",
      password: "manga-password"
    });

    expect(MANGADEX_TOKEN_ENDPOINT).toBe(
      "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token"
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
      "refresh-token"
    );

    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-token");
    expect(form.get("username")).toBeNull();
    expect(form.get("password")).toBeNull();
  });
});
