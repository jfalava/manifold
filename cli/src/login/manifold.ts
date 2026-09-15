/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { Effect, Option, Schema } from "effect";
import { manifoldUserAgent, type JsonValue } from "@manifold/json";

import {
  cliError,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  newId,
  platformFetch,
  runHost,
  type CliEffectError,
} from "@/effect-kit";

export const MANIFOLD_CLI_OAUTH_CLIENT_ID = "manifold-cli";
export const MANIFOLD_CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:8768/callback";
export const MANIFOLD_SESSION_SECRET = { service: "manifold", name: "manifold-session" };

export interface ManifoldSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

const Session = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.NonEmptyString,
  expiresAt: Schema.Finite,
});

const parseStoredSession = (stored: string): ManifoldSession | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(Session)(parsed));
};

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
});

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const createVerifier = (): string => base64Url(crypto.getRandomValues(new Uint8Array(48)));

const createChallenge = (verifier: string): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then((digest) => base64Url(new Uint8Array(digest)));

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

export interface ManifoldAuthorization {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
}

const createManifoldAuthorizationEffect = (
  origin: string,
): Effect.Effect<ManifoldAuthorization, never> =>
  Effect.gen(function* () {
    const state = newId();
    const verifier = createVerifier();
    const challenge = yield* Effect.promise(() => createChallenge(verifier));
    const url = new URL(`${normalizeOrigin(origin)}/v1/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: MANIFOLD_CLI_OAUTH_CLIENT_ID,
      redirect_uri: MANIFOLD_CLI_OAUTH_REDIRECT_URI,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.href, state, verifier };
  });

export const createManifoldAuthorization = (origin: string): Promise<ManifoldAuthorization> =>
  runHost(createManifoldAuthorizationEffect(origin));

const decodeTokenResponse = (body: JsonValue | undefined): ManifoldSession | undefined => {
  const tokens = Option.getOrUndefined(Schema.decodeUnknownOption(TokenResponse)(body));
  if (!tokens || tokens.expires_in <= 0) {
    return undefined;
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: epochMillisNow() + tokens.expires_in * 1000,
  };
};

const exchangeManifoldCodeEffect = (
  origin: string,
  code: string,
  verifier: string,
): Effect.Effect<ManifoldSession, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch(`${normalizeOrigin(origin)}/v1/oauth/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": manifoldUserAgent("cli"),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: MANIFOLD_CLI_OAUTH_CLIENT_ID,
          redirect_uri: MANIFOLD_CLI_OAUTH_REDIRECT_URI,
          code,
          code_verifier: verifier,
        }),
      }),
    );
    if (!response.ok) {
      return yield* cliError(
        `Manifold OAuth exchange failed: HTTP ${response.status}. Run login manifold again.`,
      );
    }
    const body = yield* jsonFromResponseEffect(response, "manifold.tokens").pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const session = decodeTokenResponse(body);
    if (!session) {
      return yield* cliError(
        "Manifold returned an invalid OAuth session. Run login manifold again.",
      );
    }
    return session;
  });

export const exchangeManifoldCode = (
  origin: string,
  code: string,
  verifier: string,
): Promise<ManifoldSession> => runHost(exchangeManifoldCodeEffect(origin, code, verifier));

export const saveManifoldSession = (session: ManifoldSession): Promise<void> =>
  Bun.secrets.set({ ...MANIFOLD_SESSION_SECRET, value: JSON.stringify(session) });

const loadManifoldSessionEffect = (): Effect.Effect<ManifoldSession | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const stored = yield* fromPromise(() => Bun.secrets.get(MANIFOLD_SESSION_SECRET));
    if (!stored) {
      return undefined;
    }
    return parseStoredSession(stored);
  });

export const loadManifoldSession = (): Promise<ManifoldSession | undefined> =>
  runHost(loadManifoldSessionEffect());

const refreshManifoldSessionEffect = (
  origin: string,
  session: ManifoldSession,
): Effect.Effect<ManifoldSession, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch(`${normalizeOrigin(origin)}/v1/oauth/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": manifoldUserAgent("cli"),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: MANIFOLD_CLI_OAUTH_CLIENT_ID,
          refresh_token: session.refreshToken,
        }),
      }),
    );
    if (!response.ok) {
      return yield* cliError(
        `Manifold OAuth refresh failed: HTTP ${response.status}. Run login manifold again.`,
      );
    }
    const body = yield* jsonFromResponseEffect(response, "manifold.refresh").pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const refreshed = decodeTokenResponse(body);
    if (!refreshed) {
      return yield* cliError(
        "Manifold returned an invalid refreshed session. Run login manifold again.",
      );
    }
    yield* fromPromise(() => saveManifoldSession(refreshed));
    return refreshed;
  });

export const refreshManifoldSession = (
  origin: string,
  session: ManifoldSession,
): Promise<ManifoldSession> => runHost(refreshManifoldSessionEffect(origin, session));
