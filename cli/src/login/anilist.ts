import { Option, Schema, Effect } from "effect";
import { manifoldUserAgent } from "@manifold/json";
import {
  cliError,
  decodeJsonOrThrow,
  decodeJsonOption,
  envString,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  newId,
  parseJsonValue,
  platformFetch,
  runHost,
  type CliEffectError,
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
): Effect.Effect<AniListSession, CliEffectError> =>
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
    ).pipe(Effect.mapError((cause) => cliError(`AniList token exchange failed: ${cause.message}`)));
    if (!response.ok) {
      return yield* cliError(
        `AniList token exchange failed: HTTP ${response.status}. Check the CLI client credentials and run login anilist again.`,
      );
    }
    const bodyResult = yield* jsonFromResponseEffect(response, "anilist.tokens").pipe(
      Effect.map((body) => ({ ok: true as const, body })),
      Effect.orElseSucceed(() => ({ ok: false as const, body: undefined })),
    );
    if (!bodyResult.ok) {
      // Schema errors can echo tokens. Do not propagate response payloads.
      return yield* cliError(
        "AniList returned an invalid token response. Run login anilist again.",
      );
    }
    const tokens = decodeJsonOption(TokenResponse, bodyResult.body);
    if (Option.isNone(tokens) || tokens.value.expires_in <= 0) {
      // Schema errors can echo tokens. Do not propagate response payloads.
      return yield* cliError(
        "AniList returned an invalid token response. Run login anilist again.",
      );
    }
    return {
      accessToken: tokens.value.access_token,
      expiresAt: epochMillisNow() + tokens.value.expires_in * 1000,
    };
  });

export const exchangeAniListCode = (
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<AniListSession> => runHost(exchangeAniListCodeEffect(clientId, clientSecret, code));

const validateAniListSessionEffect = (
  accessToken: string,
): Effect.Effect<{ id: number; name: string }, CliEffectError> =>
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
    ).pipe(Effect.mapError((cause) => cliError(`AniList profile lookup failed: ${cause.message}`)));
    if (!response.ok) {
      return yield* cliError(
        `AniList profile lookup failed: HTTP ${response.status}. Login has not been saved.`,
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
): Effect.Effect<string | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const override = explicit ?? envString("MANIFOLD_ANILIST_TOKEN");
    if (override) {
      return override;
    }
    const stored = yield* fromPromise(() => secrets.get(ANILIST_SECRET)).pipe(
      Effect.mapError((cause) => cliError(`AniList keychain read failed: ${cause.message}`)),
    );
    if (!stored) {
      return undefined;
    }
    const session = yield* Effect.try({
      try: () => decodeJsonOrThrow(Session, parseJsonValue(stored), "decode"),
      catch: () => cliError("Invalid AniList keychain session. Run login anilist again."),
    });
    if (session.expiresAt <= epochMillisNow() + 60_000) {
      return yield* cliError(
        "AniList login expired. Run login anilist again; AniList does not support refresh tokens.",
      );
    }
    return session.accessToken;
  });

export const resolveAniListToken = (
  explicit?: string,
  secrets: AniListSecretStore = defaultSecretStore(),
): Promise<string | undefined> => runHost(resolveAniListTokenEffect(explicit, secrets));
