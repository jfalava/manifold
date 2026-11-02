/** @effect-diagnostics asyncFunction:off */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHref, requestInitText } from "@manifold/json";

import { createPkceChallenge } from "../src/oauth";
import { migrate } from "../src/manifold-sync/migrate";
import {
  authorizeManifoldAccessToken,
  completeGithubOAuth,
  createManifoldOAuthAuthorization,
  exchangeManifoldOAuthToken,
  MANIFOLD_CLI_OAUTH_CLIENT_ID,
  MANIFOLD_CLI_OAUTH_REDIRECT_URI,
  MANIFOLD_OAUTH_CLIENT_ID,
  MANIFOLD_OAUTH_REDIRECT_URI,
  revokeManifoldSession,
} from "../src/manifold-sync/manifold-oauth";
import type { SqlHost } from "../src/manifold-sync/host";
import type { Env } from "../src/types";
import { testEnv } from "./env-fixture";

const isBigInt = (value: SQLOutputValue): value is bigint => typeof value === "bigint";

const sqliteParameter = (value: SqlStorageValue): SQLInputValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

const storageValue = (value: SQLOutputValue): SqlStorageValue => {
  if (isBigInt(value)) {
    return Number(value);
  }

  return value instanceof Uint8Array ? new Uint8Array(value).buffer : value;
};

const storageRow = (row: Record<string, SQLOutputValue>): Record<string, SqlStorageValue> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, storageValue(value)]));

const requiredSearchParam = (href: string, name: string): string => {
  const value = new URL(href).searchParams.get(name);

  if (!value) {
    throw new Error(`Missing ${name} in ${href}`);
  }

  return value;
};

const environment: Env = {
  ...testEnv(),
  MANIFOLD_OAUTH_REDIRECT_BASE_URL: "https://manifold.example",
  MANIFOLD_GITHUB_CLIENT_ID: "github-client-id",
  MANIFOLD_GITHUB_ALLOWED_USER_ID: "12345",
  MANIFOLD_GITHUB_CLIENT_SECRET: "github-client-secret",
};

const makeHost = () => {
  const database = new DatabaseSync(":memory:");

  // Overload mirrors `SqlStorage.exec`: row types are declared by the caller, not checked.
  function exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...parameters: SqlStorageValue[]
  ): { toArray(): T[] };
  function exec(query: string, ...parameters: SqlStorageValue[]) {
    if (parameters.length === 0 && query.includes(";")) {
      database.exec(query);

      const empty: Record<string, SqlStorageValue>[] = [];

      return { toArray: () => empty };
    }

    const rows = database
      .prepare(query)
      .all(...parameters.map(sqliteParameter))
      .map(storageRow);

    return { toArray: () => rows };
  }

  const host: SqlHost = {
    ctx: { storage: { sql: { exec } } },
    env: environment,
  };

  migrate(host);

  return { host, close: () => database.close() };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Manifold GitHub OAuth", () => {
  it("exchanges a GitHub callback into a one-time PKCE session", async () => {
    const { host, close } = makeHost();

    try {
      const verifier = "paperback-verifier";
      const challenge = await createPkceChallenge(verifier);

      const start = await createManifoldOAuthAuthorization(host, {
        clientId: MANIFOLD_OAUTH_CLIENT_ID,
        redirectUri: MANIFOLD_OAUTH_REDIRECT_URI,
        responseType: "code",
        state: "paperback-state",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });

      const authorizationUrl = new URL(start.authorizationUrl);
      const providerState = requiredSearchParam(start.authorizationUrl, "state");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("scope")).toBe("read:user");

      const githubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestHref(input);

        if (url === "https://github.com/login/oauth/access_token") {
          const body =
            init?.body instanceof URLSearchParams
              ? init.body.toString()
              : (requestInitText(init) ?? "");

          const form = new URLSearchParams(body);
          expect(form.get("client_secret")).toBe("github-client-secret");
          expect(form.get("code_verifier")).toBeTruthy();

          return Response.json({ access_token: "github-access-token" });
        }

        expect(url).toBe("https://api.github.com/user");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-access-token");

        return Response.json({ id: 12345 });
      });

      vi.stubGlobal("fetch", githubFetch);

      const callback = await completeGithubOAuth(host, providerState, "github-code");
      const callbackUrl = new URL(callback.redirectUri);
      expect(callbackUrl.protocol).toBe("paperback:");
      expect(callbackUrl.searchParams.get("state")).toBe("paperback-state");
      const authorizationCode = requiredSearchParam(callback.redirectUri, "code");
      expect(authorizationCode).toMatch(/^mf_code_/);

      const session = await exchangeManifoldOAuthToken(host, {
        grantType: "authorization_code",
        clientId: MANIFOLD_OAUTH_CLIENT_ID,
        redirectUri: MANIFOLD_OAUTH_REDIRECT_URI,
        code: authorizationCode,
        codeVerifier: verifier,
      });

      expect(session.access_token).toMatch(/^mf_access_/);
      expect(session.refresh_token).toMatch(/^mf_refresh_/);
      expect(await authorizeManifoldAccessToken(host, session.access_token)).toBe(true);
      await expect(
        exchangeManifoldOAuthToken(host, {
          grantType: "authorization_code",
          clientId: MANIFOLD_OAUTH_CLIENT_ID,
          redirectUri: MANIFOLD_OAUTH_REDIRECT_URI,
          code: authorizationCode,
          codeVerifier: verifier,
        }),
      ).rejects.toThrow("invalid or expired");

      expect(githubFetch).toHaveBeenCalledTimes(2);
    } finally {
      close();
    }
  });

  it("consumes refresh tokens by rotation and revokes the active session", async () => {
    const { host, close } = makeHost();

    try {
      const verifier = "refresh-verifier";
      const challenge = await createPkceChallenge(verifier);

      const start = await createManifoldOAuthAuthorization(host, {
        clientId: MANIFOLD_OAUTH_CLIENT_ID,
        redirectUri: MANIFOLD_OAUTH_REDIRECT_URI,
        responseType: "code",
        state: "refresh-state",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });

      const providerState = requiredSearchParam(start.authorizationUrl, "state");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (requestHref(input).includes("access_token")) {
          return Response.json({ access_token: "github-access-token" });
        }

        return Response.json({ id: 12345 });
      });
      const callback = await completeGithubOAuth(host, providerState, "github-code");
      const code = requiredSearchParam(callback.redirectUri, "code");

      const original = await exchangeManifoldOAuthToken(host, {
        grantType: "authorization_code",
        clientId: MANIFOLD_OAUTH_CLIENT_ID,
        redirectUri: MANIFOLD_OAUTH_REDIRECT_URI,
        code,
        codeVerifier: verifier,
      });

      const replacement = await exchangeManifoldOAuthToken(host, {
        grantType: "refresh_token",
        clientId: MANIFOLD_OAUTH_CLIENT_ID,
        refreshToken: original.refresh_token,
      });

      expect(replacement.refresh_token).not.toBe(original.refresh_token);
      expect(await authorizeManifoldAccessToken(host, original.access_token)).toBe(false);
      expect(await authorizeManifoldAccessToken(host, replacement.access_token)).toBe(true);
      await expect(
        exchangeManifoldOAuthToken(host, {
          grantType: "refresh_token",
          clientId: MANIFOLD_OAUTH_CLIENT_ID,
          refreshToken: original.refresh_token,
        }),
      ).rejects.toThrow("invalid or expired");

      await revokeManifoldSession(host, replacement.access_token);
      expect(await authorizeManifoldAccessToken(host, replacement.access_token)).toBe(false);
    } finally {
      close();
    }
  });

  it("rejects GitHub accounts outside the configured personal allowlist", async () => {
    const { host, close } = makeHost();

    try {
      const verifier = "blocked-verifier";
      const challenge = await createPkceChallenge(verifier);

      const start = await createManifoldOAuthAuthorization(host, {
        clientId: MANIFOLD_OAUTH_CLIENT_ID,
        redirectUri: MANIFOLD_OAUTH_REDIRECT_URI,
        responseType: "code",
        state: "blocked-state",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });

      const providerState = requiredSearchParam(start.authorizationUrl, "state");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
        requestHref(input).includes("access_token")
          ? Response.json({ access_token: "github-access-token" })
          : Response.json({ id: 99999 }),
      );

      const callback = await completeGithubOAuth(host, providerState, "github-code");
      const callbackUrl = new URL(callback.redirectUri);
      expect(callbackUrl.searchParams.get("error")).toBe("access_denied");
      expect(callbackUrl.searchParams.get("code")).toBeNull();
      expect(callback.accountMismatch).toBe(true);
    } finally {
      close();
    }
  });

  it("keeps CLI account-mismatch failures on the loopback OAuth redirect", async () => {
    const { host, close } = makeHost();

    try {
      const challenge = await createPkceChallenge("cli-blocked-verifier");

      const start = await createManifoldOAuthAuthorization(host, {
        clientId: MANIFOLD_CLI_OAUTH_CLIENT_ID,
        redirectUri: MANIFOLD_CLI_OAUTH_REDIRECT_URI,
        responseType: "code",
        state: "cli-blocked-state",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });

      const providerState = requiredSearchParam(start.authorizationUrl, "state");
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
        requestHref(input).includes("access_token")
          ? Response.json({ access_token: "github-access-token" })
          : Response.json({ id: 99999 }),
      );

      const callback = await completeGithubOAuth(host, providerState, "github-code");
      const callbackUrl = new URL(callback.redirectUri);
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(MANIFOLD_CLI_OAUTH_REDIRECT_URI);
      expect(callbackUrl.searchParams.get("error")).toBe("access_denied");
      expect(callbackUrl.searchParams.get("state")).toBe("cli-blocked-state");
      expect(callback.accountMismatch).toBeUndefined();
    } finally {
      close();
    }
  });
});
