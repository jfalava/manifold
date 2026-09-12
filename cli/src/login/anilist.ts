import { Schema, Effect } from "effect";
import { manifoldUserAgent } from "@manifold/json";
import {
  decodeJsonOrThrow,
  envString,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  newId,
  parseJsonValue,
  platformFetch,
  runHost,
} from "@/effect-kit";

export const ANILIST_REDIRECT_URI = "http://127.0.0.1:8767/callback";
export const ANILIST_SECRET = { service: "manifold", name: "anilist-session" };
const Session = Schema.Struct({ accessToken: Schema.NonEmptyString, expiresAt: Schema.Finite });
export type AniListSession = Schema.Schema.Type<typeof Session>;
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
});
const ViewerResponse = Schema.Struct({
  data: Schema.Struct({ Viewer: Schema.Struct({ id: Schema.Int, name: Schema.NonEmptyString }) }),
});

export type AniListSecretStore = {
  readonly get: (name: typeof ANILIST_SECRET) => Promise<string | null>;
};

const defaultSecretStore = (): AniListSecretStore => ({
  get: (name) => Bun.secrets.get(name),
});

export const createAniListAuthorization = (clientId: string) => {
  const state = newId();
  const url = new URL("https://anilist.co/api/v2/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ANILIST_REDIRECT_URI,
    response_type: "code",
    state,
  }).toString();
  return { url: url.href, state };
};

const exchangeAniListCodeEffect = (
  clientId: string,
  clientSecret: string,
  code: string,
): Effect.Effect<AniListSession, Error> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch("https://anilist.co/api/v2/oauth/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": manifoldUserAgent("cli"),
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: ANILIST_REDIRECT_URI,
          code,
        }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(`AniList token exchange failed: ${String(cause)}`),
      ),
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(
          `AniList token exchange failed: HTTP ${response.status}. Check the CLI client credentials and run login anilist again.`,
        ),
      );
    }
    const bodyResult = yield* jsonFromResponseEffect(response, "anilist.tokens").pipe(
      Effect.map((body) => ({ ok: true as const, body })),
      Effect.orElseSucceed(() => ({ ok: false as const, body: undefined })),
    );
    try {
      if (!bodyResult.ok) {
        throw new Error("invalid body");
      }
      const tokens = decodeJsonOrThrow(TokenResponse, bodyResult.body, "decode");
      if (tokens.expires_in <= 0) {
        throw new Error("Expired token");
      }
      return {
        accessToken: tokens.access_token,
        expiresAt: epochMillisNow() + tokens.expires_in * 1000,
      };
    } catch {
      // Schema errors can echo tokens. Do not propagate response payloads.
      return yield* Effect.fail(
        new Error("AniList returned an invalid token response. Run login anilist again."),
      );
    }
  });

export const exchangeAniListCode = (
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<AniListSession> => runHost(exchangeAniListCodeEffect(clientId, clientSecret, code));

const validateAniListSessionEffect = (
  accessToken: string,
): Effect.Effect<{ id: number; name: string }, Error> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch("https://graphql.anilist.co", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": manifoldUserAgent("cli"),
        },
        body: JSON.stringify({ query: "query { Viewer { id name } }" }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(`AniList profile lookup failed: ${String(cause)}`),
      ),
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(
          `AniList profile lookup failed: HTTP ${response.status}. Login has not been saved.`,
        ),
      );
    }
    const body = yield* jsonFromResponseEffect(response, "anilist.viewer");
    return decodeJsonOrThrow(ViewerResponse, body, "anilist.viewer").data.Viewer;
  });

export const validateAniListSession = (
  accessToken: string,
): Promise<{ id: number; name: string }> => runHost(validateAniListSessionEffect(accessToken));

/** Explicit flag > environment > keychain. Missing login remains optional for alias searches. */
const resolveAniListTokenEffect = (
  explicit?: string,
  secrets: AniListSecretStore = defaultSecretStore(),
): Effect.Effect<string | undefined, Error> =>
  Effect.gen(function* () {
    const override = explicit ?? envString("MANIFOLD_ANILIST_TOKEN");
    if (override) {
      return override;
    }
    const stored = yield* fromPromise(() => secrets.get(ANILIST_SECRET)).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(`AniList keychain read failed: ${String(cause)}`),
      ),
    );
    if (!stored) {
      return undefined;
    }
    let session: AniListSession;
    try {
      session = decodeJsonOrThrow(Session, parseJsonValue(stored), "decode");
    } catch {
      return yield* Effect.fail(
        new Error("Invalid AniList keychain session. Run login anilist again."),
      );
    }
    if (session.expiresAt <= epochMillisNow() + 60_000) {
      return yield* Effect.fail(
        new Error(
          "AniList login expired. Run login anilist again; AniList does not support refresh tokens.",
        ),
      );
    }
    return session.accessToken;
  });

export const resolveAniListToken = (
  explicit?: string,
  secrets: AniListSecretStore = defaultSecretStore(),
): Promise<string | undefined> => runHost(resolveAniListTokenEffect(explicit, secrets));
