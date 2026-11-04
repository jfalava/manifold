/** @effect-diagnostics asyncFunction:off */
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
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
import { handleDevice } from "../src/routes/device";
import { handleOAuth } from "../src/routes/oauth";
import type { Env, ManifoldSyncStub } from "../src/types";
import { testEnv, unusedSyncStub } from "./env-fixture";

const environment = {
  MANIFOLD_ANILIST_CLIENT_ID: "anilist-client",
  MANIFOLD_ANILIST_CLIENT_SECRET: "anilist-secret",
  MANIFOLD_MAL_CLIENT_ID: "mal-client",
  MANIFOLD_MAL_CLIENT_SECRET: "",
};

describe("OAuth provider configuration", () => {
  it("builds public callback and device URLs behind the /api router mount", () => {
    const bareOrigin = "https://example.test/";
    const apiOrigin = "https://example.test/api/";

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
    expect(isPublicOAuthRoute("POST", ["v1", "oauth", "device_authorization"])).toBe(true);
    expect(isPublicOAuthRoute("GET", ["v1", "oauth", "device"])).toBe(true);
    expect(isPublicOAuthRoute("POST", ["v1", "oauth", "device"])).toBe(true);
    expect(isPublicOAuthRoute("GET", ["v1", "oauth", "device_authorization"])).toBe(false);
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
    expect(publicSiteOrigin("https://example.test/")).toBe("https://example.test");
    expect(publicSiteOrigin("https://example.test/api")).toBe("https://example.test");
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

    const sync: ManifoldSyncStub = {
      ...unusedSyncStub(),
      completeGithubOAuth: async () => completeResult,
    };

    const env: Env = {
      ...testEnv(),
      MANIFOLD_SYNC: {
        getByName: () => sync,
      },
    };

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

describe("CLI device approval routes", () => {
  const route = async (
    request: Request,
    sync: Partial<ManifoldSyncStub>,
    path: readonly string[],
  ): Promise<Response> => {
    const env: Env = {
      ...testEnv(),
      MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://manifold.example",
      MANIFOLD_SYNC: { getByName: () => ({ ...unusedSyncStub(), ...sync }) },
    };

    const ctx = { request, env, url: new URL(request.url), path };

    const response =
      (await Effect.runPromise(handleOAuth(ctx))) ?? (await Effect.runPromise(handleDevice(ctx)));

    if (!response) {
      throw new Error("route returned no response");
    }

    return response;
  };

  const approvePost = (headers: Record<string, string>) =>
    new Request("https://manifold.example/v1/oauth/device", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: "code=BCDFGHJK&action=approve",
    });

  const devicePath = ["v1", "oauth", "device"];

  it("shows the code and both choices without a script", async () => {
    const response = await route(
      new Request("https://manifold.example/v1/oauth/device?code=bcdf-ghjk"),
      { lookupDeviceGrant: async () => "pending" },
      devicePath,
    );

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("BCDF-GHJK");
    expect(body).toContain('value="approve"');
    expect(body).toContain('value="deny"');
    expect(body).not.toContain("<script");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // no-referrer would make Chrome send `Origin: null` on the approval post.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("blocks cross-site approval posts before touching the grant", async () => {
    const beginDeviceApproval = vi.fn();

    const attempts: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "https://manifold.example", "sec-fetch-site": "cross-site" },
      {},
    ];

    for (const headers of attempts) {
      const response = await route(approvePost(headers), { beginDeviceApproval }, devicePath);
      expect(response.status).toBe(403);
    }

    expect(beginDeviceApproval).not.toHaveBeenCalled();
  });

  it("sends a same-origin approval to GitHub with a browser-binding cookie", async () => {
    const response = await route(
      approvePost({ origin: "https://manifold.example", "sec-fetch-site": "same-origin" }),
      {
        beginDeviceApproval: async () => ({
          kind: "redirect",
          authorizationUrl: "https://github.com/login/oauth/authorize?state=device.x",
          browserBinding: "binding-value",
        }),
      },
      devicePath,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://github.com/login/oauth/authorize?state=device.x",
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("manifold_device_binding=binding-value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("routes device GitHub callbacks to the grant with the binding cookie", async () => {
    const completeDeviceGithub = vi.fn(async () => "approved" as const);
    const completeGithubOAuth = vi.fn();

    const response = await route(
      new Request(
        "https://manifold.example/v1/oauth/github/callback?state=device.abc&code=github-code",
        { headers: { cookie: "other=1; manifold_device_binding=binding-value" } },
      ),
      { completeDeviceGithub, completeGithubOAuth },
      ["v1", "oauth", "github", "callback"],
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("CLI signed in");
    expect(completeDeviceGithub).toHaveBeenCalledWith(
      "device.abc",
      "binding-value",
      "github-code",
      undefined,
    );
    expect(completeGithubOAuth).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("answers device-code polls with RFC 8628 error bodies", async () => {
    const response = await route(
      new Request("https://manifold.example/v1/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "manifold-cli",
          device_code: "mf_device_x",
        }),
      }),
      { pollDeviceToken: async () => ({ kind: "error", error: "authorization_pending" }) },
      ["v1", "oauth", "token"],
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "authorization_pending" });
  });
});
