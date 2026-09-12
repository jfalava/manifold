/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHref, requestInitText } from "@manifold/json";

import {
  ANILIST_REDIRECT_URI,
  createAniListAuthorization,
  exchangeAniListCode,
  resolveAniListToken,
  validateAniListSession,
} from "../../src/login/anilist";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MANIFOLD_ANILIST_TOKEN;
});

describe("AniList authorization", () => {
  it("builds a code-flow authorize URL with fresh state and the loopback redirect", () => {
    const auth = createAniListAuthorization("client");
    const params = new URL(auth.url).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("client");
    expect(params.get("redirect_uri")).toBe(ANILIST_REDIRECT_URI);
    expect(params.get("state")).toBe(auth.state);
    expect(createAniListAuthorization("client").state).not.toBe(auth.state);
  });

  it("exchanges a code without leaking malformed token payloads", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ access_token: "SECRET_TOKEN", expires_in: "SECRET_VALUE" }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(exchangeAniListCode("client", "secret", "code")).rejects.toThrow(
      /^AniList returned an invalid token response\. Run login anilist again\.$/,
    );
    expect(requestHref(fetcher.mock.calls[0]?.[0] ?? "")).toBe(
      "https://anilist.co/api/v2/oauth/token",
    );
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(requestInitText(init) ?? "")).toEqual({
      grant_type: "authorization_code",
      client_id: "client",
      client_secret: "secret",
      redirect_uri: ANILIST_REDIRECT_URI,
      code: "code",
    });
  });

  it("stores expiresAt from a successful token exchange", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "tok", expires_in: 3600 })),
    );
    await expect(exchangeAniListCode("client", "secret", "code")).resolves.toEqual({
      accessToken: "tok",
      expiresAt: now + 3600_000,
    });
  });

  it("validates a session via Viewer and rejects HTTP failures without saving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { Viewer: { id: 9, name: "reader" } } })),
    );
    await expect(validateAniListSession("tok")).resolves.toEqual({ id: 9, name: "reader" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(validateAniListSession("tok")).rejects.toThrow(
      "AniList profile lookup failed: HTTP 401. Login has not been saved.",
    );
  });
});

describe("resolveAniListToken", () => {
  const secrets = (value: string | null) => ({
    get: vi.fn(async () => value),
  });

  it("prefers an explicit flag, then MANIFOLD_ANILIST_TOKEN, over the keychain", async () => {
    process.env.MANIFOLD_ANILIST_TOKEN = "env-token";
    const store = secrets(
      JSON.stringify({ accessToken: "keychain", expiresAt: Date.now() + 3_600_000 }),
    );
    await expect(resolveAniListToken("flag-token", store)).resolves.toBe("flag-token");
    await expect(resolveAniListToken(undefined, store)).resolves.toBe("env-token");
    expect(store.get).not.toHaveBeenCalled();
  });

  it("returns a non-expired keychain session when no override is set", async () => {
    const store = secrets(
      JSON.stringify({ accessToken: "keychain", expiresAt: Date.now() + 3_600_000 }),
    );
    await expect(resolveAniListToken(undefined, store)).resolves.toBe("keychain");
  });

  it("rejects expired or malformed keychain sessions", async () => {
    await expect(
      resolveAniListToken(
        undefined,
        secrets(JSON.stringify({ accessToken: "keychain", expiresAt: Date.now() - 1 })),
      ),
    ).rejects.toThrow(/AniList login expired\. Run login anilist again/);

    await expect(resolveAniListToken(undefined, secrets("{not-json"))).rejects.toThrow(
      "Invalid AniList keychain session. Run login anilist again.",
    );
  });

  it("returns undefined when nothing is configured", async () => {
    await expect(resolveAniListToken(undefined, secrets(null))).resolves.toBeUndefined();
  });
});
