import { expect, test } from "bun:test";

import {
  ACCESS_AUDIENCE,
  ACCESS_ISSUER,
  type AccessKeySet,
  createAccessVerifier,
} from "../src/lib/access-auth";

interface TokenHeader {
  readonly alg: string;
  readonly kid: string;
}

interface TokenClaims {
  readonly aud: string | readonly string[];
  readonly iss: string;
  readonly exp: number;
  readonly nbf: number;
  readonly sub: string;
}

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const NOW = 1_800_000_000;

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const segment = (value: TokenHeader | TokenClaims): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** A signing key and the entry Access would publish for it under `kid`. */
const signer = async (kid: string) => {
  const pair = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  const { n = "", e = "" } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk: AccessKeySet["keys"][number] = { kid, kty: "RSA", n, e };

  const sign = async (
    claims: TokenClaims,
    header: TokenHeader = { alg: "RS256", kid },
  ): Promise<string> => {
    const signed = `${segment(header)}.${segment(claims)}`;

    const signature = await crypto.subtle.sign(
      RSA.name,
      pair.privateKey,
      new TextEncoder().encode(signed),
    );

    return `${signed}.${base64Url(new Uint8Array(signature))}`;
  };

  return { jwk, sign };
};

const claims = (overrides: Partial<TokenClaims> = {}): TokenClaims => ({
  aud: [ACCESS_AUDIENCE],
  iss: ACCESS_ISSUER,
  exp: NOW + 600,
  nbf: NOW - 5,
  sub: "user",
  ...overrides,
});

const team = await signer("team-key");
const teamKeys = () => Promise.resolve({ keys: [team.jwk] });

test("a token Access signed for this application is accepted", async () => {
  const verify = createAccessVerifier(teamKeys);

  expect(await verify(await team.sign(claims()), NOW)).toEqual({ ok: true });
  expect(
    await verify(await team.sign(claims({ aud: ["another-app", ACCESS_AUDIENCE] })), NOW),
  ).toEqual({ ok: true });
});

test("a request without a token, or with a mangled one, is refused", async () => {
  const verify = createAccessVerifier(teamKeys);
  const token = await team.sign(claims());

  expect((await verify(null, NOW)).ok).toBe(false);
  expect((await verify("", NOW)).ok).toBe(false);
  expect((await verify(token.split(".").slice(0, 2).join("."), NOW)).ok).toBe(false);
  expect((await verify(`${token}.extra`, NOW)).ok).toBe(false);
});

test("correct claims signed by someone else's key are refused", async () => {
  const verify = createAccessVerifier(teamKeys);
  const attacker = await signer("team-key");

  expect(await verify(await attacker.sign(claims()), NOW)).toEqual({
    ok: false,
    reason: "Access token signature does not verify",
  });
});

test("a token that swaps the signed claims is refused", async () => {
  const verify = createAccessVerifier(teamKeys);
  const [header = "", , signature = ""] = (await team.sign(claims({ exp: NOW - 1 }))).split(".");

  expect((await verify(`${header}.${segment(claims())}.${signature}`, NOW)).ok).toBe(false);
});

test("a token that names its own algorithm is refused", async () => {
  const verify = createAccessVerifier(teamKeys);
  const unsigned = `${segment({ alg: "none", kid: "team-key" })}.${segment(claims())}.`;
  const hmac = await team.sign(claims(), { alg: "HS256", kid: "team-key" });

  expect((await verify(unsigned, NOW)).ok).toBe(false);
  expect((await verify(hmac, NOW)).ok).toBe(false);
});

test("a token the team signed for another application or issuer is refused", async () => {
  const verify = createAccessVerifier(teamKeys);

  expect(await verify(await team.sign(claims({ aud: ["another-app"] })), NOW)).toEqual({
    ok: false,
    reason: "Access token is for another application",
  });
  expect(await verify(await team.sign(claims({ aud: `${ACCESS_AUDIENCE}0` })), NOW)).toEqual({
    ok: false,
    reason: "Access token is for another application",
  });
  expect(
    await verify(await team.sign(claims({ iss: "https://other.cloudflareaccess.com" })), NOW),
  ).toEqual({ ok: false, reason: "Access token is from another issuer" });
});

test("a token is accepted until the second it expires", async () => {
  const verify = createAccessVerifier(teamKeys);
  const token = await team.sign(claims({ exp: NOW + 10 }));

  expect((await verify(token, NOW + 9)).ok).toBe(true);
  expect((await verify(token, NOW + 10)).ok).toBe(false);
  expect((await verify(await team.sign(claims({ nbf: NOW + 3600 })), NOW)).ok).toBe(false);
});

test("a rotated key is picked up, but unknown keys reload at most once a minute", async () => {
  const rotated = await signer("rotated-key");
  let published = [team.jwk];
  let loads = 0;

  const verify = createAccessVerifier(() => {
    loads += 1;

    return Promise.resolve({ keys: published });
  });

  expect((await verify(await team.sign(claims()), NOW)).ok).toBe(true);

  published = [team.jwk, rotated.jwk];

  const token = await rotated.sign(claims());

  expect((await verify(token, NOW + 59)).ok).toBe(false);
  expect(loads).toBe(1);
  expect((await verify(token, NOW + 60)).ok).toBe(true);
  expect(loads).toBe(2);
});

test("unreachable keys refuse the request and are retried on the next one", async () => {
  let reachable = false;

  const verify = createAccessVerifier(() =>
    reachable ? teamKeys() : Promise.reject(new Error("certs timed out")),
  );

  const token = await team.sign(claims());

  expect(await verify(token, NOW)).toEqual({
    ok: false,
    reason: "Access keys unavailable: Error: certs timed out",
  });

  reachable = true;

  expect((await verify(token, NOW + 1)).ok).toBe(true);
});
