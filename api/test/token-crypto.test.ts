import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, fromBase64Url, toBase64Url } from "../src/token-crypto";
import type { Env } from "../src/types";

const environment: Pick<Env, "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET"> = {
  MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: "test-encryption-secret",
};

describe("token crypto", () => {
  it("round-trips Base64URL characters", () => {
    const bytes = new Uint8Array([251, 255]);

    expect(toBase64Url(bytes)).toBe("-_8");
    expect(fromBase64Url("-_8")).toEqual(bytes);
  });

  it("round-trips an encrypted token", async () => {
    const token = "secret OAuth token";

    const encrypted = await encryptToken(environment, token);

    expect(encrypted).not.toContain(token);
    expect(await decryptToken(environment, encrypted)).toBe(token);
  });
});
