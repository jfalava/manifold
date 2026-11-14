/** @effect-diagnostics asyncFunction:off */
import { Option, Schema } from "effect";

import { platformFetch } from "./effect-host";

/**
 * Cloudflare Access sits in front of /admin and signs every request it lets
 * through. The Worker checks that signature itself, so the panel stays closed
 * if a route or the Access application is ever changed by mistake.
 */
export const ACCESS_ISSUER = "https://jfa-d.cloudflareaccess.com";

/** The "Manifold" Access application. Other applications of the team sign with the same keys. */
export const ACCESS_AUDIENCE = "e3e4ba96742b923bd136fb6b3f054867c6ca047d47af07b614f5357173d6f761";

const ACCESS_CERTS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;

/** Access rotates its keys; a token naming an unknown key reloads them at most this often. */
const KEY_RELOAD_SECONDS = 60;

const CLOCK_SKEW_SECONDS = 60;

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const JsonText = Schema.fromJsonString(Schema.Unknown);

// Only RS256: a token that picks its own algorithm ("none", HS256) is rejected here.
const HeaderSchema = Schema.Struct({ alg: Schema.Literal("RS256"), kid: Schema.String });

const ClaimsSchema = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  iss: Schema.String,
  exp: Schema.Finite,
  nbf: Schema.optional(Schema.Finite),
});

const KeySetSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kid: Schema.String,
      kty: Schema.Literal("RSA"),
      n: Schema.String,
      e: Schema.String,
    }),
  ),
});

export type AccessKeySet = typeof KeySetSchema.Type;

export type AccessCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const denied = (reason: string): AccessCheck => ({ ok: false, reason });

const base64UrlBytes = (segment: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const segmentJson = (segment: string): Option.Option<unknown> => {
  const bytes = base64UrlBytes(segment);

  return bytes === null
    ? Option.none()
    : Schema.decodeOption(JsonText)(new TextDecoder().decode(bytes));
};

/** The team's public signing keys, as Access publishes them. */
export const fetchAccessKeySet = async (): Promise<AccessKeySet> => {
  const response = await platformFetch(ACCESS_CERTS_URL, { signal: AbortSignal.timeout(5000) });

  if (!response.ok) {
    throw new Error(`Access certs returned HTTP ${response.status}`);
  }

  const keySet = Schema.decodeUnknownOption(KeySetSchema)(await response.json());

  if (Option.isNone(keySet)) {
    throw new Error("Access certs response has no usable keys");
  }

  return keySet.value;
};

/**
 * Returns a check for the `Cf-Access-Jwt-Assertion` header of one request.
 * `now` is in seconds. Every failure, including unreachable keys, is a denial.
 */
export const createAccessVerifier = (loadKeySet: () => Promise<AccessKeySet>) => {
  let keys: ReadonlyMap<string, CryptoKey> = new Map();
  let loadedAt = Number.NEGATIVE_INFINITY;

  const keyFor = async (kid: string, now: number): Promise<CryptoKey | undefined> => {
    const known = keys.get(kid);

    if (known !== undefined || now - loadedAt < KEY_RELOAD_SECONDS) {
      return known;
    }

    const keySet = await loadKeySet();
    const loaded = new Map<string, CryptoKey>();

    for (const jwk of keySet.keys) {
      loaded.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, n: jwk.n, e: jwk.e },
          RSA_SHA256,
          false,
          ["verify"],
        ),
      );
    }

    // Only a successful load starts the wait, so a failed one is retried on the next request.
    keys = loaded;
    loadedAt = now;

    return loaded.get(kid);
  };

  return async (token: string | null, now: number): Promise<AccessCheck> => {
    if (!token) {
      return denied("no Access token on the request");
    }

    const parts = token.split(".");
    const [headerPart = "", claimsPart = "", signaturePart = ""] = parts;

    const header = Option.flatMap(
      segmentJson(headerPart),
      Schema.decodeUnknownOption(HeaderSchema),
    );

    const claims = Option.flatMap(
      segmentJson(claimsPart),
      Schema.decodeUnknownOption(ClaimsSchema),
    );

    const signature = base64UrlBytes(signaturePart);

    if (
      parts.length !== 3 ||
      Option.isNone(header) ||
      Option.isNone(claims) ||
      signature === null
    ) {
      return denied("malformed Access token");
    }

    try {
      const key = await keyFor(header.value.kid, now);

      if (key === undefined) {
        return denied("Access token is signed with an unknown key");
      }

      const signed = new TextEncoder().encode(`${headerPart}.${claimsPart}`);

      if (!(await crypto.subtle.verify(RSA_SHA256, key, signature, signed))) {
        return denied("Access token signature does not verify");
      }
    } catch (cause) {
      return denied(`Access keys unavailable: ${String(cause)}`);
    }

    const { aud, iss, exp, nbf } = claims.value;

    if (iss !== ACCESS_ISSUER) {
      return denied("Access token is from another issuer");
    }

    // `aud` is one audience or a list of them.
    if (![aud].flat().includes(ACCESS_AUDIENCE)) {
      return denied("Access token is for another application");
    }

    if (exp <= now || (nbf !== undefined && nbf > now + CLOCK_SKEW_SECONDS)) {
      return denied("Access token is expired or not yet valid");
    }

    return { ok: true };
  };
};
