/** OAuth PKCE uses Web Crypto digests at the Worker edge. */
/** @effect-diagnostics asyncFunction:off */
import { Schema } from "effect";
import type { OAuthProvider } from "./domain";
import { readSecret, readSecretOptional } from "./read-secret";
import { toBase64Url } from "./token-crypto";
import type { RuntimeSecret } from "./types";

export interface OAuthEnvironment {
  readonly MANIFOLD_ANILIST_CLIENT_ID: string;
  readonly MANIFOLD_ANILIST_CLIENT_SECRET: RuntimeSecret;
  readonly MANIFOLD_MAL_CLIENT_ID: string;
  readonly MANIFOLD_MAL_CLIENT_SECRET: RuntimeSecret;
}

export interface OAuthClientConfig {
  readonly provider: OAuthProvider;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pkceMethod?: "plain" | "S256";
}

export interface OAuthStart {
  readonly provider: OAuthProvider;
  readonly authorizationUrl: string;
}

export const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  token_type: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.optional(Schema.Finite),
  scope: Schema.optional(Schema.String),
});
export type OAuthTokenResponse = Schema.Schema.Type<typeof OAuthTokenResponse>;

export const getOAuthClientConfig = async (
  provider: OAuthProvider,
  env: OAuthEnvironment,
): Promise<OAuthClientConfig> => {
  if (provider === "anilist") {
    return {
      provider,
      authorizationEndpoint: "https://anilist.co/api/v2/oauth/authorize",
      tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
      clientId: env.MANIFOLD_ANILIST_CLIENT_ID,
      clientSecret: await readSecret(
        env.MANIFOLD_ANILIST_CLIENT_SECRET,
        "MANIFOLD_ANILIST_CLIENT_SECRET",
      ),
      pkceMethod: undefined,
    };
  }

  return {
    provider,
    authorizationEndpoint: "https://myanimelist.net/v1/oauth2/authorize",
    tokenEndpoint: "https://myanimelist.net/v1/oauth2/token",
    clientId: env.MANIFOLD_MAL_CLIENT_ID,
    clientSecret:
      (await readSecretOptional(env.MANIFOLD_MAL_CLIENT_SECRET, "MANIFOLD_MAL_CLIENT_SECRET")) ??
      "",
    pkceMethod: "plain",
  };
};

export const createRandomValue = (bytes = 32): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
};

export const createPkceChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
};

export const createAuthorizationUrl = (
  config: OAuthClientConfig,
  redirectUri: string,
  state: string,
  codeChallenge?: string,
): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
  });

  if (config.pkceMethod && codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", config.pkceMethod);
  }

  return `${config.authorizationEndpoint}?${params}`;
};
