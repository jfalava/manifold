import { Effect, Schema } from "effect";
import { manifoldUserAgent } from "@manifold/json";

import { manifoldOAuthCallbackUri } from "../http";
import { platformFetch } from "../effect-host";
import { readSecret } from "../read-secret";
import { createPkceChallenge, createRandomValue } from "../oauth";
import { toBase64Url } from "../token-crypto";
import type {
  ManifoldOAuthCodeRow,
  ManifoldOAuthRequestRow,
  ManifoldSessionRow,
} from "../sync-rows";
import { now } from "./constants";
import { apiError, fromPromise } from "./from-promise";
import type { SyncHost } from "./host";

export const MANIFOLD_OAUTH_CLIENT_ID = "paperback";
export const MANIFOLD_OAUTH_REDIRECT_URI = "paperback://manifold-login";
export const MANIFOLD_CLI_OAUTH_CLIENT_ID = "manifold-cli";
export const MANIFOLD_CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:8768/callback";
export const MANIFOLD_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MANIFOLD_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const OAUTH_CODE_TTL_MS = 60 * 1000;
const GITHUB_AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";

const isSupportedClient = (clientId: string, redirectUri: string): boolean =>
  (clientId === MANIFOLD_OAUTH_CLIENT_ID && redirectUri === MANIFOLD_OAUTH_REDIRECT_URI) ||
  (clientId === MANIFOLD_CLI_OAUTH_CLIENT_ID && redirectUri === MANIFOLD_CLI_OAUTH_REDIRECT_URI);

export interface ManifoldOAuthAuthorizationInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly responseType: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
}

export interface ManifoldOAuthRedirect {
  readonly redirectUri: string;
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
  readonly accountMismatch?: boolean;
}

export interface ManifoldOAuthTokenInput {
  readonly grantType: string;
  readonly clientId?: string;
  readonly redirectUri?: string;
  readonly code?: string;
  readonly codeVerifier?: string;
  readonly refreshToken?: string;
}

export interface ManifoldOAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token_expires_in: number;
}

const GithubTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
});

const GithubUserResponse = Schema.Struct({
  id: Schema.Finite,
});

const hashOpaque = (value: string): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => toBase64Url(new Uint8Array(digest)));

const withQuery = (base: string, values: Record<string, string>): string => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};

const redirectWithError = (
  redirectUri: string,
  state: string,
  error: string,
): ManifoldOAuthRedirect => ({
  redirectUri: withQuery(redirectUri, { error, state }),
  state,
  error,
});

const startManifoldOAuthEffect = (host: SyncHost, input: ManifoldOAuthAuthorizationInput) =>
  Effect.gen(function* () {
    if (
      !isSupportedClient(input.clientId, input.redirectUri) ||
      input.responseType !== "code" ||
      input.codeChallengeMethod !== "S256" ||
      input.state.length === 0 ||
      input.codeChallenge.length === 0
    ) {
      return yield* apiError("Invalid Manifold OAuth authorization request");
    }

    const providerState = createRandomValue();
    const providerCodeVerifier = createRandomValue(48);
    const providerCodeChallenge = yield* fromPromise(() =>
      createPkceChallenge(providerCodeVerifier),
    );
    const createdAt = now();

    host.ctx.storage.sql.exec(
      "DELETE FROM manifold_oauth_requests WHERE created_at < ?",
      createdAt - OAUTH_REQUEST_TTL_MS,
    );
    host.ctx.storage.sql.exec(
      `INSERT INTO manifold_oauth_requests
       (provider_state, client_id, redirect_uri, outer_state, code_challenge,
        provider_code_verifier, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      providerState,
      input.clientId,
      input.redirectUri,
      input.state,
      input.codeChallenge,
      providerCodeVerifier,
      createdAt,
    );

    yield* fromPromise(() =>
      readSecret(host.env.MANIFOLD_GITHUB_CLIENT_SECRET, "MANIFOLD_GITHUB_CLIENT_SECRET"),
    );
    const callback = manifoldOAuthCallbackUri(host.env);
    const authorizationUrl = withQuery(GITHUB_AUTHORIZE_ENDPOINT, {
      client_id: host.env.MANIFOLD_GITHUB_CLIENT_ID,
      redirect_uri: callback,
      response_type: "code",
      scope: "read:user",
      state: providerState,
      code_challenge: providerCodeChallenge,
      code_challenge_method: "S256",
    });

    return { authorizationUrl };
  });

export const createManifoldOAuthAuthorization = (
  host: SyncHost,
  input: ManifoldOAuthAuthorizationInput,
): Promise<{ readonly authorizationUrl: string }> =>
  Effect.runPromise(startManifoldOAuthEffect(host, input));

const completeGithubOAuthEffect = (host: SyncHost, state: string, code?: string, error?: string) =>
  Effect.gen(function* () {
    const request = host.ctx.storage.sql
      .exec<ManifoldOAuthRequestRow>(
        `SELECT * FROM manifold_oauth_requests
       WHERE provider_state = ? AND created_at >= ?`,
        state,
        now() - OAUTH_REQUEST_TTL_MS,
      )
      .toArray()[0];
    if (!request) {
      return yield* apiError("Manifold OAuth session is invalid or expired");
    }

    // Consume upstream state before external I/O so a callback cannot be replayed.
    host.ctx.storage.sql.exec(
      "DELETE FROM manifold_oauth_requests WHERE provider_state = ?",
      state,
    );

    if (error || !code) {
      return redirectWithError(request.redirect_uri, request.outer_state, error ?? "access_denied");
    }

    const clientSecret = yield* fromPromise(() =>
      readSecret(host.env.MANIFOLD_GITHUB_CLIENT_SECRET, "MANIFOLD_GITHUB_CLIENT_SECRET"),
    );
    const callback = manifoldOAuthCallbackUri(host.env);
    const tokenResponse = yield* fromPromise(() =>
      platformFetch(GITHUB_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": manifoldUserAgent("api"),
        },
        body: new URLSearchParams({
          client_id: host.env.MANIFOLD_GITHUB_CLIENT_ID,
          client_secret: clientSecret,
          code,
          redirect_uri: callback,
          code_verifier: request.provider_code_verifier,
        }),
      }),
    );
    if (!tokenResponse.ok) {
      return redirectWithError(request.redirect_uri, request.outer_state, "server_error");
    }
    const tokenBody = yield* fromPromise(() => tokenResponse.json());
    const githubToken = yield* Schema.decodeUnknownEffect(GithubTokenResponse)(tokenBody);

    const userResponse = yield* fromPromise(() =>
      platformFetch(GITHUB_USER_ENDPOINT, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${githubToken.access_token}`,
          "user-agent": manifoldUserAgent("api"),
        },
      }),
    );
    if (!userResponse.ok) {
      return redirectWithError(request.redirect_uri, request.outer_state, "server_error");
    }
    const userBody = yield* fromPromise(() => userResponse.json());
    const githubUser = yield* Schema.decodeUnknownEffect(GithubUserResponse)(userBody);
    if (String(githubUser.id) !== host.env.MANIFOLD_GITHUB_ALLOWED_USER_ID) {
      const rejected = redirectWithError(
        request.redirect_uri,
        request.outer_state,
        "access_denied",
      );
      return request.client_id === MANIFOLD_OAUTH_CLIENT_ID
        ? { ...rejected, accountMismatch: true }
        : rejected;
    }
    const subject = `github:${String(githubUser.id)}`;
    const authorizationCode = yield* issueAuthorizationCodeEffect(host, request, subject);
    return {
      redirectUri: withQuery(request.redirect_uri, {
        code: authorizationCode,
        state: request.outer_state,
      }),
      state: request.outer_state,
      code: authorizationCode,
    };
  });

export const completeGithubOAuth = (
  host: SyncHost,
  state: string,
  code?: string,
  error?: string,
): Promise<ManifoldOAuthRedirect> =>
  Effect.runPromise(completeGithubOAuthEffect(host, state, code, error));

const issueAuthorizationCodeEffect = (
  host: SyncHost,
  request: ManifoldOAuthRequestRow,
  subject: string,
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const code = `mf_code_${createRandomValue(32)}`;
    const codeHash = yield* Effect.promise(() => hashOpaque(code));
    const createdAt = now();
    host.ctx.storage.sql.exec(
      `INSERT INTO manifold_oauth_codes
       (code_hash, client_id, redirect_uri, code_challenge, subject, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      codeHash,
      request.client_id,
      request.redirect_uri,
      request.code_challenge,
      subject,
      createdAt,
      createdAt + OAUTH_CODE_TTL_MS,
    );
    return code;
  });

const createSessionEffect = (
  host: SyncHost,
  subject: string,
): Effect.Effect<ManifoldOAuthTokenResponse, never> =>
  Effect.gen(function* () {
    const accessToken = `mf_access_${createRandomValue(32)}`;
    const refreshToken = `mf_refresh_${createRandomValue(48)}`;
    const accessTokenHash = yield* Effect.promise(() => hashOpaque(accessToken));
    const refreshTokenHash = yield* Effect.promise(() => hashOpaque(refreshToken));
    const createdAt = now();
    host.ctx.storage.sql.exec(
      `INSERT INTO manifold_sessions
       (access_token_hash, refresh_token_hash, subject, access_expires_at,
        refresh_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      accessTokenHash,
      refreshTokenHash,
      subject,
      createdAt + MANIFOLD_ACCESS_TOKEN_TTL_SECONDS * 1000,
      createdAt + MANIFOLD_REFRESH_TOKEN_TTL_SECONDS * 1000,
      createdAt,
      createdAt,
    );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer" as const,
      expires_in: MANIFOLD_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token_expires_in: MANIFOLD_REFRESH_TOKEN_TTL_SECONDS,
    };
  });

const exchangeManifoldOAuthTokenEffect = (host: SyncHost, input: ManifoldOAuthTokenInput) =>
  Effect.gen(function* () {
    if (
      input.clientId !== MANIFOLD_OAUTH_CLIENT_ID &&
      input.clientId !== MANIFOLD_CLI_OAUTH_CLIENT_ID
    ) {
      return yield* apiError("Invalid Manifold OAuth client");
    }

    if (input.grantType === "authorization_code") {
      const code = input.code;
      const redirectUri = input.redirectUri;
      const codeVerifier = input.codeVerifier;
      if (!code || !redirectUri || !codeVerifier) {
        return yield* apiError("Manifold OAuth code exchange is incomplete");
      }
      const codeHash = yield* fromPromise(() => hashOpaque(code));
      const row = host.ctx.storage.sql
        .exec<ManifoldOAuthCodeRow>(
          `DELETE FROM manifold_oauth_codes
         WHERE code_hash = ? AND expires_at >= ?
         RETURNING *`,
          codeHash,
          now(),
        )
        .toArray()[0];
      if (!row) {
        return yield* apiError("Manifold OAuth code is invalid or expired");
      }

      // The DELETE ... RETURNING is the consume operation. An invalid verifier
      // must not leave a reusable authorization code behind, and concurrent
      // exchanges can only consume one row.
      if (row.redirect_uri !== redirectUri || row.client_id !== input.clientId) {
        return yield* apiError("Manifold OAuth code does not match the client");
      }
      const challenge = yield* fromPromise(() => createPkceChallenge(codeVerifier));
      if (challenge !== row.code_challenge) {
        return yield* apiError("Manifold OAuth PKCE verification failed");
      }
      return yield* createSessionEffect(host, row.subject);
    }

    if (input.grantType === "refresh_token") {
      if (!input.refreshToken) {
        return yield* apiError("Manifold OAuth refresh token is missing");
      }
      const refreshTokenHash = yield* fromPromise(() => hashOpaque(input.refreshToken!));
      const row = host.ctx.storage.sql
        .exec<ManifoldSessionRow>(
          `UPDATE manifold_sessions
         SET revoked_at = ?, updated_at = ?
         WHERE refresh_token_hash = ? AND refresh_expires_at > ? AND revoked_at IS NULL
         RETURNING *`,
          now(),
          now(),
          refreshTokenHash,
          now(),
        )
        .toArray()[0];
      if (!row) {
        return yield* apiError("Manifold OAuth refresh token is invalid or expired");
      }

      return yield* createSessionEffect(host, row.subject);
    }

    return yield* apiError("Unsupported Manifold OAuth grant type");
  });

export const exchangeManifoldOAuthToken = (
  host: SyncHost,
  input: ManifoldOAuthTokenInput,
): Promise<ManifoldOAuthTokenResponse> =>
  Effect.runPromise(exchangeManifoldOAuthTokenEffect(host, input));

const authorizeManifoldAccessTokenEffect = (host: SyncHost, accessToken: string) =>
  Effect.gen(function* () {
    if (!accessToken) {
      return false;
    }
    const hash = yield* fromPromise(() => hashOpaque(accessToken));
    const row = host.ctx.storage.sql
      .exec<ManifoldSessionRow>(
        `SELECT access_token_hash FROM manifold_sessions
       WHERE access_token_hash = ? AND access_expires_at > ? AND revoked_at IS NULL`,
        hash,
        now(),
      )
      .toArray()[0];
    return row !== undefined;
  });

export const authorizeManifoldAccessToken = (
  host: SyncHost,
  accessToken: string,
): Promise<boolean> => Effect.runPromise(authorizeManifoldAccessTokenEffect(host, accessToken));

const revokeManifoldSessionEffect = (host: SyncHost, token: string) =>
  Effect.gen(function* () {
    if (!token) {
      return;
    }
    const hash = yield* fromPromise(() => hashOpaque(token));
    host.ctx.storage.sql.exec(
      `UPDATE manifold_sessions SET revoked_at = ?, updated_at = ?
     WHERE (access_token_hash = ? OR refresh_token_hash = ?) AND revoked_at IS NULL`,
      now(),
      now(),
      hash,
      hash,
    );
  });

export const revokeManifoldSession = (host: SyncHost, token: string): Promise<void> =>
  Effect.runPromise(revokeManifoldSessionEffect(host, token));
