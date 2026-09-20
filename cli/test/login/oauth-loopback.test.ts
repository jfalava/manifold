import { describe, expect, it } from "vitest";

import {
  isBulkPasteChunk,
  parseOAuthCallbackInput,
  resolveOAuthAuthorizationCode,
} from "../../src/login/oauth-loopback";

describe("parseOAuthCallbackInput", () => {
  it("accepts a bare authorization code", () => {
    expect(parseOAuthCallbackInput("  abcd.EFGH  ")).toEqual({
      code: "abcd.EFGH",
      state: null,
      denied: false,
    });
  });

  it("accepts code#state (hosted-relay paste form)", () => {
    expect(parseOAuthCallbackInput("auth-code#state-value")).toEqual({
      code: "auth-code",
      state: "state-value",
      denied: false,
    });
  });

  it("parses a full loopback callback URL", () => {
    const url =
      "http://127.0.0.1:8767/callback?code=the-code&state=the-state&extra=1";
    expect(parseOAuthCallbackInput(url)).toEqual({
      code: "the-code",
      state: "the-state",
      denied: false,
    });
  });

  it("flags OAuth error redirects as denied", () => {
    expect(
      parseOAuthCallbackInput(
        "http://127.0.0.1:8766/callback?error=access_denied&state=s",
      ),
    ).toEqual({
      code: "",
      state: "s",
      denied: true,
    });
  });

  it("rejects empty input", () => {
    expect(() => parseOAuthCallbackInput("   ")).toThrow(
      /Paste an authorization code or the full callback URL/,
    );
  });
});

describe("resolveOAuthAuthorizationCode", () => {
  it("returns the code when state matches or is omitted", () => {
    expect(resolveOAuthAuthorizationCode("only-code", "expected", "AniList")).toBe("only-code");
    expect(
      resolveOAuthAuthorizationCode(
        "http://127.0.0.1:8767/callback?code=c&state=expected",
        "expected",
        "AniList",
      ),
    ).toBe("c");
  });

  it("rejects state mismatch and denied flows", () => {
    expect(() =>
      resolveOAuthAuthorizationCode(
        "http://127.0.0.1:8767/callback?code=c&state=other",
        "expected",
        "AniList",
      ),
    ).toThrow(/OAuth state does not match/);

    expect(() =>
      resolveOAuthAuthorizationCode(
        "http://127.0.0.1:8767/callback?error=access_denied&state=expected",
        "expected",
        "MAL",
      ),
    ).toThrow(/MAL authorization denied/);
  });
});

describe("isBulkPasteChunk", () => {
  it("treats multi-character pastes as bulk, including OAuth codes with c", () => {
    expect(isBulkPasteChunk("c")).toBe(false);
    expect(isBulkPasteChunk("C")).toBe(false);
    expect(isBulkPasteChunk("\u001b[200~paste")).toBe(false);
    expect(
      isBulkPasteChunk(
        "http://127.0.0.1:8767/callback?code=def50200cabc&state=abc\n",
      ),
    ).toBe(true);
    expect(isBulkPasteChunk("def50200737b346d68ae438984a06fd1")).toBe(true);
  });
});
