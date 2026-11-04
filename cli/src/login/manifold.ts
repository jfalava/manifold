import { Effect, Option, Schema } from "effect";
import { manifoldUserAgent, type JsonValue } from "@manifold/json";

import {
  cliError,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  platformFetch,
  runHost,
  sleep,
  type CliEffectError,
} from "@/effect-kit";

export const MANIFOLD_CLI_OAUTH_CLIENT_ID = "manifold-cli";
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

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.NonEmptyString,
  expires_in: Schema.Finite,
  interval: Schema.Finite,
});

const DeviceTokenError = Schema.Struct({ error: Schema.String });

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

export interface ManifoldDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Opens the approval page with the code filled in. */
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

const postForm = (origin: string, path: string, params: Record<string, string>) =>
  fromPromise(() =>
    platformFetch(`${normalizeOrigin(origin)}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": manifoldUserAgent("cli"),
      },
      body: new URLSearchParams({ client_id: MANIFOLD_CLI_OAUTH_CLIENT_ID, ...params }),
    }),
  );

const startManifoldDeviceLoginEffect = (
  origin: string,
): Effect.Effect<ManifoldDeviceAuthorization, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* postForm(origin, "/v1/oauth/device_authorization", {});

    if (!response.ok) {
      return yield* cliError(
        `Manifold device login failed to start: HTTP ${response.status}. Check --api-origin.`,
      );
    }

    const body = yield* jsonFromResponseEffect(response, "manifold.device_authorization").pipe(
      Effect.orElseSucceed(() => undefined),
    );

    const grant = Option.getOrUndefined(
      Schema.decodeUnknownOption(DeviceAuthorizationResponse)(body),
    );

    if (!grant) {
      return yield* cliError("Manifold returned an invalid device authorization response.");
    }

    return {
      deviceCode: grant.device_code,
      userCode: grant.user_code,
      verificationUri: grant.verification_uri,
      verificationUriComplete: grant.verification_uri_complete,
      expiresInSeconds: grant.expires_in,
      intervalSeconds: Math.max(1, grant.interval),
    };
  });

export const startManifoldDeviceLogin = (origin: string): Promise<ManifoldDeviceAuthorization> =>
  runHost(startManifoldDeviceLoginEffect(origin));

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

/** Decodes a Manifold token-endpoint response into a session, or fails with a re-login hint. */
const decodeSessionResponseEffect = (
  response: Response,
  grant: "device" | "refresh",
): Effect.Effect<ManifoldSession, CliEffectError> =>
  Effect.gen(function* () {
    if (!response.ok) {
      return yield* cliError(
        `Manifold OAuth ${grant} failed: HTTP ${response.status}. Run login manifold again.`,
      );
    }

    const body = yield* jsonFromResponseEffect(response, `manifold.${grant}`).pipe(
      Effect.orElseSucceed(() => undefined),
    );

    const session = decodeTokenResponse(body);

    if (!session) {
      return yield* cliError(
        `Manifold returned an invalid OAuth ${grant} session. Run login manifold again.`,
      );
    }

    return session;
  });

/** POSTs a refresh grant to the Manifold token endpoint and decodes the returned session. */
const requestManifoldSessionEffect = (
  origin: string,
  params: Record<string, string>,
): Effect.Effect<ManifoldSession, CliEffectError> =>
  postForm(origin, "/v1/oauth/token", params).pipe(
    Effect.flatMap((response) => decodeSessionResponseEffect(response, "refresh")),
  );

/**
 * RFC 8628 §3.5 polling: wait `interval` between polls, add 5 s on
 * `slow_down`, keep going on `authorization_pending`, stop on anything else.
 */
const pollManifoldDeviceSessionEffect = (
  origin: string,
  grant: ManifoldDeviceAuthorization,
): Effect.Effect<ManifoldSession, CliEffectError> =>
  Effect.gen(function* () {
    let intervalMs = grant.intervalSeconds * 1000;
    const deadline = epochMillisNow() + grant.expiresInSeconds * 1000;

    while (epochMillisNow() < deadline) {
      yield* sleep(intervalMs);

      const response = yield* postForm(origin, "/v1/oauth/token", {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: grant.deviceCode,
      });

      if (response.ok) {
        return yield* decodeSessionResponseEffect(response, "device");
      }

      const body = yield* jsonFromResponseEffect(response, "manifold.device").pipe(
        Effect.orElseSucceed(() => undefined),
      );

      const error = Option.getOrUndefined(
        Schema.decodeUnknownOption(DeviceTokenError)(body),
      )?.error;

      if (error === "authorization_pending") {
        continue;
      }

      if (error === "slow_down") {
        intervalMs += 5000;
        continue;
      }

      if (error === "access_denied") {
        return yield* cliError("Manifold sign-in was denied in the browser.");
      }

      if (error === "expired_token") {
        break;
      }

      return yield* cliError(
        `Manifold device login failed: ${error ?? `HTTP ${response.status}`}. Run login manifold again.`,
      );
    }

    return yield* cliError("Manifold sign-in code expired. Run login manifold again.");
  });

/** Polls until the browser approves; abort the signal to cancel (Esc / Ctrl+C). */
export const pollManifoldDeviceSession = (
  origin: string,
  grant: ManifoldDeviceAuthorization,
  signal?: AbortSignal,
): Promise<ManifoldSession> =>
  Effect.runPromise(pollManifoldDeviceSessionEffect(origin, grant), signal ? { signal } : {});

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
    const refreshed = yield* requestManifoldSessionEffect(origin, {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    });

    yield* fromPromise(() => saveManifoldSession(refreshed));

    return refreshed;
  });

export const refreshManifoldSession = (
  origin: string,
  session: ManifoldSession,
): Promise<ManifoldSession> => runHost(refreshManifoldSessionEffect(origin, session));
