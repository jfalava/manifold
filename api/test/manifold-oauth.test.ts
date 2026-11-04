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
  MANIFOLD_OAUTH_CLIENT_ID,
  MANIFOLD_OAUTH_REDIRECT_URI,
  revokeManifoldSession,
} from "../src/manifold-sync/manifold-oauth";
import {
  beginDeviceApproval,
  completeDeviceGithub,
  denyDeviceGrant,
  DEVICE_GRANT_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  lookupDeviceGrant,
  pollDeviceToken,
  startDeviceAuthorization,
} from "../src/manifold-sync/device-grant";
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

  it("no longer issues authorization codes to the CLI loopback redirect", async () => {
    const { host, close } = makeHost();

    try {
      await expect(
        createManifoldOAuthAuthorization(host, {
          clientId: MANIFOLD_CLI_OAUTH_CLIENT_ID,
          redirectUri: "http://127.0.0.1:8768/callback",
          responseType: "code",
          state: "cli-state",
          codeChallenge: await createPkceChallenge("cli-verifier"),
          codeChallengeMethod: "S256",
        }),
      ).rejects.toThrow("Invalid Manifold OAuth authorization request");
    } finally {
      close();
    }
  });
});

const stubGithub = (userId: number) => {
  const githubFetch = vi.fn(async (input: RequestInfo | URL) =>
    requestHref(input).includes("access_token")
      ? Response.json({ access_token: "github-access-token" })
      : Response.json({ id: userId }),
  );

  vi.stubGlobal("fetch", githubFetch);

  return githubFetch;
};

describe("Manifold CLI device grant", () => {
  const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

  const at = (offsetMs: number): void => {
    vi.setSystemTime(T0 + offsetMs);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues tokens once after the owner approves in the browser that started it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const { host, close } = makeHost();

    try {
      const grant = await startDeviceAuthorization(host, MANIFOLD_CLI_OAUTH_CLIENT_ID);

      if (!grant) {
        throw new Error("device authorization rejected the CLI client");
      }

      expect(grant.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(grant.verification_uri).toBe("https://manifold.example/device");
      expect(grant.verification_uri_complete).toBe(
        `https://manifold.example/device?code=${grant.user_code}`,
      );
      expect(grant.interval).toBe(DEVICE_POLL_INTERVAL_SECONDS);

      const poll = () => pollDeviceToken(host, MANIFOLD_CLI_OAUTH_CLIENT_ID, grant.device_code);

      expect(await poll()).toEqual({ kind: "error", error: "authorization_pending" });

      // Typed in lower case without the dash, as a user might.
      const lowered = grant.user_code.replace("-", "").toLowerCase();
      expect(await lookupDeviceGrant(host, lowered)).toBe("pending");

      const start = await beginDeviceApproval(host, lowered);

      if (start.kind !== "redirect") {
        throw new Error(`expected a GitHub redirect, got ${start.status}`);
      }

      const providerState = requiredSearchParam(start.authorizationUrl, "state");
      expect(new URL(start.authorizationUrl).searchParams.get("redirect_uri")).toBe(
        "https://manifold.example/api/v1/oauth/github/callback",
      );

      const githubFetch = stubGithub(12345);

      // A callback without the binding cookie (another browser) leaves the grant pending.
      expect(await completeDeviceGithub(host, providerState, undefined, "github-code")).toBe(
        "wrong-browser",
      );
      expect(githubFetch).not.toHaveBeenCalled();

      expect(
        await completeDeviceGithub(host, providerState, start.browserBinding, "github-code"),
      ).toBe("approved");

      // The upstream state is single-use.
      expect(
        await completeDeviceGithub(host, providerState, start.browserBinding, "github-code"),
      ).toBe("expired");

      at(DEVICE_POLL_INTERVAL_SECONDS * 1000);
      const result = await poll();

      if (result.kind !== "token") {
        throw new Error(`expected tokens, got ${result.error}`);
      }

      expect(result.token.access_token).toMatch(/^mf_access_/);
      expect(await authorizeManifoldAccessToken(host, result.token.access_token)).toBe(true);

      // The CLI refreshes the device-issued session with the ordinary refresh grant.
      const refreshed = await exchangeManifoldOAuthToken(host, {
        grantType: "refresh_token",
        clientId: MANIFOLD_CLI_OAUTH_CLIENT_ID,
        refreshToken: result.token.refresh_token,
      });

      expect(refreshed.access_token).toMatch(/^mf_access_/);

      expect(await poll()).toEqual({ kind: "error", error: "invalid_grant" });
    } finally {
      close();
    }
  });

  it("answers slow_down and widens the interval when the CLI polls too fast", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const { host, close } = makeHost();

    try {
      const grant = await startDeviceAuthorization(host, MANIFOLD_CLI_OAUTH_CLIENT_ID);

      if (!grant) {
        throw new Error("device authorization rejected the CLI client");
      }

      const poll = () => pollDeviceToken(host, MANIFOLD_CLI_OAUTH_CLIENT_ID, grant.device_code);

      expect(await poll()).toEqual({ kind: "error", error: "authorization_pending" });
      at(2000);
      expect(await poll()).toEqual({ kind: "error", error: "slow_down" });
      // 7 s after the last poll is past the original 5 s interval but inside the widened 10 s one.
      at(9000);
      expect(await poll()).toEqual({ kind: "error", error: "slow_down" });
      at(9000 + 15_000);
      expect(await poll()).toEqual({ kind: "error", error: "authorization_pending" });
    } finally {
      close();
    }
  });

  it("stops the CLI on deny, on a foreign GitHub account keeps waiting, and expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const { host, close } = makeHost();

    try {
      const denied = await startDeviceAuthorization(host, MANIFOLD_CLI_OAUTH_CLIENT_ID);
      const foreign = await startDeviceAuthorization(host, MANIFOLD_CLI_OAUTH_CLIENT_ID);
      const expiring = await startDeviceAuthorization(host, MANIFOLD_CLI_OAUTH_CLIENT_ID);

      if (!denied || !foreign || !expiring) {
        throw new Error("device authorization rejected the CLI client");
      }

      expect(await denyDeviceGrant(host, denied.user_code)).toBe("denied");
      expect(await beginDeviceApproval(host, denied.user_code)).toEqual({
        kind: "status",
        status: "denied",
      });
      expect(await pollDeviceToken(host, MANIFOLD_CLI_OAUTH_CLIENT_ID, denied.device_code)).toEqual(
        { kind: "error", error: "access_denied" },
      );

      const start = await beginDeviceApproval(host, foreign.user_code);

      if (start.kind !== "redirect") {
        throw new Error("expected a GitHub redirect");
      }

      stubGithub(99999);
      expect(
        await completeDeviceGithub(
          host,
          requiredSearchParam(start.authorizationUrl, "state"),
          start.browserBinding,
          "github-code",
        ),
      ).toBe("mismatch");
      expect(await lookupDeviceGrant(host, foreign.user_code)).toBe("pending");

      at(DEVICE_GRANT_TTL_SECONDS * 1000 + 1);
      expect(await lookupDeviceGrant(host, expiring.user_code)).toBe("unknown");
      expect(
        await pollDeviceToken(host, MANIFOLD_CLI_OAUTH_CLIENT_ID, expiring.device_code),
      ).toEqual({ kind: "error", error: "expired_token" });
    } finally {
      close();
    }
  });

  it("rejects other clients", async () => {
    const { host, close } = makeHost();

    try {
      expect(await startDeviceAuthorization(host, MANIFOLD_OAUTH_CLIENT_ID)).toBeUndefined();
      expect(await pollDeviceToken(host, MANIFOLD_OAUTH_CLIENT_ID, "mf_device_x")).toEqual({
        kind: "error",
        error: "invalid_client",
      });
    } finally {
      close();
    }
  });
});
