import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  handleLoopbackRequest,
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
    const url = "http://127.0.0.1:8767/callback?code=the-code&state=the-state&extra=1";
    expect(parseOAuthCallbackInput(url)).toEqual({
      code: "the-code",
      state: "the-state",
      denied: false,
    });
  });

  it("flags OAuth error redirects as denied", () => {
    expect(
      parseOAuthCallbackInput("http://127.0.0.1:8766/callback?error=access_denied&state=s"),
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
    expect(isBulkPasteChunk("http://127.0.0.1:8767/callback?code=def50200cabc&state=abc\n")).toBe(
      true,
    );
    expect(isBulkPasteChunk("def50200737b346d68ae438984a06fd1")).toBe(true);
  });
});

describe("loopback callback pages", () => {
  it.each([
    ["code=secret-code&state=expected", 200, "Authorization received", "secret-code"],
    ["error=access_denied&state=expected", 200, "Authorization declined", "denied"],
    ["error=server_error&state=expected", 200, "Manifold could not authorize", "failed"],
    ["error=&code=secret-code&state=expected", 200, "Manifold could not authorize", "failed"],
    ["code=secret-code&state=other", 400, "This callback was not accepted", "waiting"],
    ["error=access_denied&state=other", 400, "This callback was not accepted", "waiting"],
    ["code=secret-code", 400, "This callback was not accepted", "waiting"],
    ["state=expected&code=", 400, "No authorization code received", "waiting"],
  ])("renders the outcome for %s", async (query, status, title, outcome) => {
    const codes: string[] = [];
    const failures: string[] = [];
    const response = handleLoopbackRequest(
      new Request(`http://127.0.0.1/callback?${query}&error_description=private-detail`),
      {
        pathname: "/callback",
        expectedState: "expected",
        providerLabel: "Manifold",
        onCode: (code) => codes.push(code),
        onError: (error) => failures.push(error.message),
      },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).toContain(`<h1>${title}</h1>`);
    expect(body).toContain("MANIFOLD CLI / Manifold");
    expect(body).not.toContain("secret-code");
    expect(body).not.toContain("private-detail");
    expect(body).not.toContain("<script");
    expect(body.includes("You can close this tab.")).toBe(status === 200);
    if (outcome === "secret-code") {
      expect(codes).toEqual(["secret-code"]);
      expect(failures).toEqual([]);
      expect(body).toContain("check whether sign-in completed");
    } else if (outcome === "waiting") {
      expect(codes).toEqual([]);
      expect(failures).toEqual([]);
    } else {
      expect(codes).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(outcome);
    }
  });

  it("escapes provider text in the title and body", async () => {
    const response = handleLoopbackRequest(
      new Request("http://127.0.0.1/callback?state=s&error=server_error"),
      {
        pathname: "/callback",
        expectedState: "s",
        providerLabel: '<script>alert("provider")</script>',
        onCode: () => {},
        onError: () => {},
      },
    );
    const body = await response.text();
    expect(body).toContain("&lt;script&gt;alert(&quot;provider&quot;)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
  });

  it.each([
    ["GET", "/favicon.ico"],
    ["POST", "/callback"],
  ])("ignores unrelated requests: %s %s", async (method, path) => {
    const outcomes: string[] = [];
    const response = handleLoopbackRequest(new Request(`http://127.0.0.1${path}`, { method }), {
      pathname: "/callback",
      expectedState: "s",
      providerLabel: "AniList",
      onCode: (code) => outcomes.push(code),
      onError: (error) => outcomes.push(error.message),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(outcomes).toEqual([]);
  });

  it("delivers complete pages through the real Bun waiter before shutdown", () => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
          import assert from "node:assert/strict";
          import { awaitOAuthAuthorizationCode } from "./src/login/oauth-loopback";
          for (const [providerLabel, query, heading, expected] of [
            ["Manifold", "code=fixture-code", "Authorization received", "fixture-code"],
            ["AniList", "error=access_denied", "Authorization declined", "AniList authorization denied."],
            ["MAL", "error=server_error", "MAL could not authorize", "MAL authorization failed. Start login again."],
          ]) {
            const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
            const redirectUri = "http://127.0.0.1:" + reserve.port + "/callback";
            await reserve.stop(true);
            const waiter = awaitOAuthAuthorizationCode({
              providerLabel, redirectUri, expectedState: "expected",
              authorizeUrl: "https://example.invalid/authorize", timeoutMs: 3000,
            }).then(code => code, error => error.message);
            for (const invalid of ["error=access_denied&state=other", "code=unsolicited", "state=expected"]) {
              const rejected = await fetch(redirectUri + "?" + invalid);
              assert.equal(rejected.status, 400);
              assert.ok((await rejected.text()).endsWith("</html>"));
            }
            const response = await fetch(redirectUri + "?state=expected&" + query);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
            const body = await response.text();
            assert.ok(body.includes("<h1>" + heading + "</h1>"));
            assert.ok(body.includes("MANIFOLD CLI / " + providerLabel));
            assert.ok(body.endsWith("</html>"));
            assert.ok(response.headers.get("content-security-policy").includes("font-src data:"));
            const encodedFont = body.split("data:font/woff2;base64,")[1]?.split('"')[0];
            assert.ok(encodedFont);
            const font = Buffer.from(encodedFont, "base64");
            assert.equal(font.toString("ascii", 0, 4), "wOF2");
            assert.equal(font.readUInt32BE(8), font.length);
            assert.ok(body.includes("SIL OPEN FONT LICENSE Version 1.1"));
            assert.equal(await waiter, expected);
          }
          console.log("All callback outcomes delivered");
        `,
      ],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("All callback outcomes delivered");
  });
});
