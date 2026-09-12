import { Schema } from "effect";
import { manifoldUserAgent } from "@manifold/json";
import { decodeJsonOrThrow, envString, epochMillisNow, newId, parseJsonValue, platformFetch } from "@/effect-kit";

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

export const exchangeAniListCode = async (clientId: string, clientSecret: string, code: string) => {
  const response = await platformFetch("https://anilist.co/api/v2/oauth/token", {
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
  });
  if (!response.ok) {
    throw new Error(
      `AniList token exchange failed: HTTP ${response.status}. Check the CLI client credentials and run login anilist again.`,
    );
  }
  try {
    const tokens = decodeJsonOrThrow(TokenResponse, (await response.json()), "decode");
    if (tokens.expires_in <= 0) {
      throw new Error("Expired token");
    }
    return { accessToken: tokens.access_token, expiresAt: epochMillisNow() + tokens.expires_in * 1000 };
  } catch {
    // Schema errors can echo tokens. Do not propagate response payloads.
    throw new Error("AniList returned an invalid token response. Run login anilist again.");
  }
};

export const validateAniListSession = async (accessToken: string) => {
  const response = await platformFetch("https://graphql.anilist.co", {
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
  });
  if (!response.ok) {
    throw new Error(
      `AniList profile lookup failed: HTTP ${response.status}. Login has not been saved.`,
    );
  }
  return decodeJsonOrThrow(ViewerResponse, (await response.json()), "anilist.viewer").data.Viewer;
};

/** Explicit flag > environment > keychain. Missing login remains optional for alias searches. */
export const resolveAniListToken = async (
  explicit?: string,
  secrets: AniListSecretStore = defaultSecretStore(),
): Promise<string | undefined> => {
  const override = explicit ?? envString("MANIFOLD_ANILIST_TOKEN");
  if (override) {
    return override;
  }
  const stored = await secrets.get(ANILIST_SECRET);
  if (!stored) {
    return undefined;
  }
  let session: AniListSession;
  try {
    session = decodeJsonOrThrow(Session, parseJsonValue(stored), "decode");
  } catch {
    throw new Error("Invalid AniList keychain session. Run login anilist again.");
  }
  if (session.expiresAt <= epochMillisNow() + 60_000) {
    throw new Error(
      "AniList login expired. Run login anilist again; AniList does not support refresh tokens.",
    );
  }
  return session.accessToken;
};
