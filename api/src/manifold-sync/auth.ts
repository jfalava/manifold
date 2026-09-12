import { Effect, Schema } from "effect";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import {
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT,
} from "@manifold/mangadex";
import type { AuthConnection, AuthProvider, OAuthProvider } from "../domain";
import { hostLogError, platformFetch } from "../effect-host";
import {
  createAuthorizationUrl,
  createPkceChallenge,
  createRandomValue,
  getOAuthClientConfig,
  OAuthTokenResponse,
  OAuthTokenResponse as OAuthTokenResponseSchema,
  type OAuthStart,
} from "../oauth";
import { readSecret } from "../read-secret";
import { type OAuthSessionRow, type OAuthTokenRow } from "../sync-rows";
import { decryptToken, encryptToken } from "../token-crypto";
import { now, SYNC_MAX_ATTEMPTS } from "./constants";
import { fromPromise } from "./from-promise";
import type { SyncHost } from "./host";
import { scheduleSync } from "./schedule";

const createOAuthSessionEffect = (
  host: SyncHost,
  provider: OAuthProvider,
  redirectUri: string,
  returnPath?: string,
): Effect.Effect<OAuthStart, unknown> =>
  Effect.gen(function* () {
    const config = yield* fromPromise(() => getOAuthClientConfig(provider, host.env));
    const state = createRandomValue();
    const codeVerifier = config.pkceMethod ? createRandomValue(48) : undefined;
    const codeChallenge = codeVerifier
      ? config.pkceMethod === "S256"
        ? yield* fromPromise(() => createPkceChallenge(codeVerifier))
        : codeVerifier
      : undefined;

    host.ctx.storage.sql.exec("DELETE FROM oauth_sessions WHERE created_at < ?", now() - 600_000);
    host.ctx.storage.sql.exec(
      `INSERT INTO oauth_sessions
       (provider, state, code_verifier, redirect_uri, return_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
      provider,
      state,
      codeVerifier ?? null,
      redirectUri,
      returnPath ?? null,
      now(),
    );

    return {
      provider,
      authorizationUrl: createAuthorizationUrl(config, redirectUri, state, codeChallenge),
    };
  });

export const createOAuthSession = (
  host: SyncHost,
  provider: OAuthProvider,
  redirectUri: string,
  returnPath?: string,
): Promise<OAuthStart> =>
  Effect.runPromise(createOAuthSessionEffect(host, provider, redirectUri, returnPath));

const completeOAuthSessionEffect = (
  host: SyncHost,
  provider: OAuthProvider,
  state: string,
  code: string,
): Effect.Effect<AuthConnection & { readonly returnPath?: string }, unknown> =>
  Effect.gen(function* () {
    const session = host.ctx.storage.sql
      .exec<OAuthSessionRow>(
        `SELECT * FROM oauth_sessions
       WHERE provider = ? AND state = ? AND created_at >= ?`,
        provider,
        state,
        now() - 600_000,
      )
      .toArray()[0];

    if (!session) {
      return yield* Effect.fail(new Error("OAuth session is invalid or expired"));
    }

    const returnPath = session.return_path ?? undefined;

    // Consume the state before external I/O so a callback cannot be replayed.
    host.ctx.storage.sql.exec(
      "DELETE FROM oauth_sessions WHERE provider = ? AND state = ?",
      provider,
      state,
    );

    const config = yield* fromPromise(() => getOAuthClientConfig(provider, host.env));
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      redirect_uri: session.redirect_uri,
    });
    if (config.clientSecret) {
      form.set("client_secret", config.clientSecret);
    }
    if (session.code_verifier) {
      form.set("code_verifier", session.code_verifier);
    }

    const response = yield* fromPromise(() =>
      platformFetch(config.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": manifoldUserAgent("api"),
        },
        body: form,
      }),
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`OAuth token exchange failed for ${provider} (${response.status})`),
      );
    }

    const body = yield* fromPromise(() => response.json());
    const token = yield* Schema.decodeUnknownEffect(OAuthTokenResponseSchema)(body);
    const connection = yield* persistTokenEffect(host, provider, token);
    return returnPath ? { ...connection, returnPath } : connection;
  });

export const completeOAuthSession = (
  host: SyncHost,
  provider: OAuthProvider,
  state: string,
  code: string,
): Promise<AuthConnection & { readonly returnPath?: string }> =>
  Effect.runPromise(completeOAuthSessionEffect(host, provider, state, code));

const cancelOAuthSessionEffect = (
  host: SyncHost,
  provider: OAuthProvider,
  state: string,
): Effect.Effect<{ readonly returnPath?: string }> =>
  Effect.sync(() => {
    const session = host.ctx.storage.sql
      .exec<OAuthSessionRow>(
        `SELECT return_path FROM oauth_sessions WHERE provider = ? AND state = ?`,
        provider,
        state,
      )
      .toArray()[0];
    host.ctx.storage.sql.exec(
      "DELETE FROM oauth_sessions WHERE provider = ? AND state = ?",
      provider,
      state,
    );
    const returnPath = session?.return_path ?? undefined;
    return returnPath ? { returnPath } : {};
  });

export const cancelOAuthSession = (
  host: SyncHost,
  provider: OAuthProvider,
  state: string,
): Promise<{ readonly returnPath?: string }> =>
  Effect.runPromise(cancelOAuthSessionEffect(host, provider, state));

const loginMangaDexEffect = (host: SyncHost): Effect.Effect<AuthConnection, unknown> =>
  Effect.gen(function* () {
    const clientSecret = yield* fromPromise(() =>
      readSecret(host.env.MANIFOLD_MANGADEX_CLIENT_SECRET, "MANIFOLD_MANGADEX_CLIENT_SECRET"),
    );
    const username = yield* fromPromise(() =>
      readSecret(host.env.MANIFOLD_MANGADEX_USERNAME, "MANIFOLD_MANGADEX_USERNAME"),
    );
    const password = yield* fromPromise(() =>
      readSecret(host.env.MANIFOLD_MANGADEX_PASSWORD, "MANIFOLD_MANGADEX_PASSWORD"),
    );

    const response = yield* fromPromise(() =>
      platformFetch(MANGADEX_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": manifoldUserAgent("api"),
        },
        body: createMangaDexPasswordGrant({
          clientId: host.env.MANIFOLD_MANGADEX_CLIENT_ID,
          clientSecret,
          username,
          password,
        }),
      }),
    );
    if (!response.ok) {
      const detail = (yield* fromPromise(() => response.text())).trim().slice(0, 500);
      return yield* Effect.fail(
        new Error(`MangaDex login failed (${response.status})` + (detail ? `: ${detail}` : "")),
      );
    }

    const body = yield* fromPromise(() => response.json());
    const token = yield* Schema.decodeUnknownEffect(OAuthTokenResponseSchema)(body);
    const connection = yield* persistTokenEffect(host, "mangadex", token);
    host.ctx.storage.sql.exec(
      `UPDATE sync_ops
     SET state = 'pending', attempts = 0, updated_at = ?
     WHERE target = 'mangadex' AND state IN ('failed', 'blocked')`,
      now(),
    );
    // Fresh credentials may unblock shelf rows parked on auth failures.
    host.ctx.storage.sql.exec(
      `UPDATE md_status_queue SET attempts = 0, last_error = NULL
     WHERE attempts >= ${SYNC_MAX_ATTEMPTS}`,
    );
    yield* fromPromise(() => scheduleSync(host)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          hostLogError(`[ManifoldSync] failed to schedule MangaDex sync: ${errorMessage(error)}`);
        }),
      ),
    );
    return connection;
  });

export const loginMangaDex = (host: SyncHost): Promise<AuthConnection> =>
  Effect.runPromise(loginMangaDexEffect(host));

const importAuthTokenEffect = (
  host: SyncHost,
  provider: AuthProvider,
  accessToken: string,
  expiresIn?: number,
): Effect.Effect<AuthConnection, unknown> =>
  Effect.gen(function* () {
    const token = accessToken.trim();
    if (!token) {
      return yield* Effect.fail(new Error("Access token is empty"));
    }
    if (provider !== "anilist" && provider !== "mal") {
      return yield* Effect.fail(new Error(`Token import is not supported for ${provider}`));
    }
    const payload: {
      readonly access_token: string;
      readonly expires_in?: number;
    } =
      expiresIn !== undefined && expiresIn > 0
        ? { access_token: token, expires_in: expiresIn }
        : { access_token: token };
    return yield* persistTokenEffect(host, provider, payload);
  });

export const importAuthToken = (
  host: SyncHost,
  provider: AuthProvider,
  accessToken: string,
  expiresIn?: number,
): Promise<AuthConnection> =>
  Effect.runPromise(importAuthTokenEffect(host, provider, accessToken, expiresIn));

export const listAuthConnections = (host: SyncHost): Promise<readonly AuthConnection[]> =>
  Effect.runPromise(
    Effect.sync(() => {
      const providers: readonly AuthProvider[] = ["anilist", "mal", "mangadex"];
      return providers.map((provider) => readAuthConnection(host, provider));
    }),
  );

export const getAuthConnection = (
  host: SyncHost,
  provider: AuthProvider,
): Promise<AuthConnection> =>
  Effect.runPromise(Effect.sync(() => readAuthConnection(host, provider)));

export const disconnectAuth = (host: SyncHost, provider: AuthProvider): Promise<void> =>
  Effect.runPromise(
    Effect.sync(() => {
      host.ctx.storage.sql.exec("DELETE FROM oauth_tokens WHERE provider = ?", provider);
    }),
  );

const getAuthAccessTokenEffect = (
  host: SyncHost,
  provider: AuthProvider,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const row = readAuthToken(host, provider);
    if (!row) {
      return yield* Effect.fail(new Error(`Auth provider is not connected: ${provider}`));
    }

    if (row.expires_at === null || row.expires_at > now() + 30_000) {
      return yield* fromPromise(() => decryptToken(host.env, row.access_token));
    }
    if (!row.refresh_token) {
      return yield* Effect.fail(new Error(`Auth provider requires reauthorization: ${provider}`));
    }

    const refreshToken = yield* fromPromise(() => decryptToken(host.env, row.refresh_token!));
    const form =
      provider === "mangadex"
        ? createMangaDexRefreshGrant(
            {
              clientId: host.env.MANIFOLD_MANGADEX_CLIENT_ID,
              clientSecret: yield* fromPromise(() =>
                readSecret(
                  host.env.MANIFOLD_MANGADEX_CLIENT_SECRET,
                  "MANIFOLD_MANGADEX_CLIENT_SECRET",
                ),
              ),
            },
            refreshToken,
          )
        : yield* Effect.gen(function* () {
            const config = yield* fromPromise(() => getOAuthClientConfig(provider, host.env));
            const refreshForm = new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: config.clientId,
            });
            if (config.clientSecret) {
              refreshForm.set("client_secret", config.clientSecret);
            }
            return refreshForm;
          });

    const tokenEndpoint =
      provider === "mangadex"
        ? MANGADEX_TOKEN_ENDPOINT
        : (yield* fromPromise(() => getOAuthClientConfig(provider, host.env))).tokenEndpoint;
    const response = yield* fromPromise(() =>
      platformFetch(tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": manifoldUserAgent("api"),
        },
        body: form,
      }),
    );
    if (!response.ok) {
      const detail = (yield* fromPromise(() => response.text())).trim().slice(0, 500);
      return yield* Effect.fail(
        new Error(
          `Auth token refresh failed for ${provider} (${response.status})` +
            (detail ? `: ${detail}` : ""),
        ),
      );
    }

    const body = yield* fromPromise(() => response.json());
    const token = yield* Schema.decodeUnknownEffect(OAuthTokenResponseSchema)(body);
    const timestamp = now();
    const latest = readAuthToken(host, provider);
    if (!latest || latest.updated_at !== row.updated_at) {
      if (!latest) {
        return yield* Effect.fail(
          new Error(`Auth provider disconnected during refresh: ${provider}`),
        );
      }
      return yield* fromPromise(() => decryptToken(host.env, latest.access_token));
    }

    const expiresAt = token.expires_in ? timestamp + token.expires_in * 1000 : null;
    const encryptedAccess = yield* fromPromise(() => encryptToken(host.env, token.access_token));
    const encryptedRefresh = token.refresh_token
      ? yield* fromPromise(() => encryptToken(host.env, token.refresh_token!))
      : null;
    host.ctx.storage.sql.exec(
      `UPDATE oauth_tokens SET
       access_token = ?,
       refresh_token = COALESCE(?, refresh_token),
       token_type = ?,
       expires_at = ?,
       scope = ?,
       updated_at = ?
     WHERE provider = ?`,
      encryptedAccess,
      encryptedRefresh,
      token.token_type ?? row.token_type,
      expiresAt,
      token.scope ?? row.scope,
      timestamp,
      provider,
    );

    return token.access_token;
  });

export const getAuthAccessToken = (host: SyncHost, provider: AuthProvider): Promise<string> =>
  Effect.runPromise(getAuthAccessTokenEffect(host, provider));

const persistTokenEffect = (
  host: SyncHost,
  provider: AuthProvider,
  token: OAuthTokenResponse,
): Effect.Effect<AuthConnection, unknown> =>
  Effect.gen(function* () {
    const timestamp = now();
    const encryptedAccessToken = yield* fromPromise(() =>
      encryptToken(host.env, token.access_token),
    );
    const encryptedRefreshToken = token.refresh_token
      ? yield* fromPromise(() => encryptToken(host.env, token.refresh_token!))
      : null;
    const expiresAt = token.expires_in ? timestamp + token.expires_in * 1000 : null;

    host.ctx.storage.sql.exec(
      `INSERT INTO oauth_tokens
       (provider, access_token, refresh_token, token_type, expires_at, scope, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       token_type = excluded.token_type,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       updated_at = excluded.updated_at`,
      provider,
      encryptedAccessToken,
      encryptedRefreshToken,
      token.token_type ?? "Bearer",
      expiresAt,
      token.scope ?? null,
      timestamp,
    );

    return {
      provider,
      connected: true,
      ...(!(expiresAt === null) && { expiresAt }),
      updatedAt: timestamp,
    };
  });

export const persistToken = (
  host: SyncHost,
  provider: AuthProvider,
  token: OAuthTokenResponse,
): Promise<AuthConnection> => Effect.runPromise(persistTokenEffect(host, provider, token));

export function readAuthConnection(host: SyncHost, provider: AuthProvider): AuthConnection {
  const row = readAuthToken(host, provider);
  return {
    provider,
    connected: row !== undefined,
    ...(row?.expires_at != null && { expiresAt: row.expires_at }),
    ...(row && { updatedAt: row.updated_at }),
  };
}

export function readAuthToken(host: SyncHost, provider: AuthProvider): OAuthTokenRow | undefined {
  return host.ctx.storage.sql
    .exec<OAuthTokenRow>("SELECT * FROM oauth_tokens WHERE provider = ?", provider)
    .toArray()[0];
}
