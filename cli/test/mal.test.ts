import { afterEach, describe, expect, it, vi } from "vitest";
import { isString, requestHref } from "@manifold/json";
import {
  createMalAuthorization,
  createMalClient,
  MAL_REDIRECT_URI,
  requestMalTokens,
  wipeMalManga,
} from "../src/mal";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const profile = () => Response.json({ id: 7, name: "reader" });
const page = (ids: number[], next?: string) =>
  Response.json({
    data: ids.map((id) => ({ node: { id, title: `Manga ${id}` } })),
    paging: next ? { next } : {},
  });

const requestBodyText = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (isString(body)) {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  throw new Error("Expected a URL-encoded request body");
};

const setup = (...responses: Response[]) => {
  const fetcher = vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected request");
    }
    return response;
  });
  vi.stubGlobal("fetch", fetcher);
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const client = createMalClient({ accessToken: "test-token", sleep });
  const scanned = vi.fn();
  const progress = vi.fn();
  return { fetcher, sleep, client, scanned, progress };
};

describe("MAL manga wipe", () => {
  it("scans all pages before any delete, deduplicates, includes adult entries, and verifies empty", async () => {
    const next = "https://api.myanimelist.net/v2/users/@me/mangalist?offset=1000&limit=1000";
    const ctx = setup(
      profile(),
      page([1, 2], next),
      page([2, 3]),
      profile(),
      new Response(null),
      new Response(null, { status: 404 }),
      new Response(null),
      page([]),
    );
    const result = await wipeMalManga({ ...ctx, apply: true });
    expect(result).toEqual({ account: "reader", accountId: 7, scanned: 3, deleted: 3 });
    expect(ctx.scanned).toHaveBeenCalledWith("reader", [
      { id: 1, title: "Manga 1" },
      { id: 2, title: "Manga 2" },
      { id: 3, title: "Manga 3" },
    ]);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map((call) => call[1]?.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "DELETE",
      "DELETE",
      "DELETE",
      "GET",
    ]);
    expect(
      calls.map((call) => requestHref(call[0])).filter((url) => url.includes("mangalist")),
    ).toSatisfy((urls: string[]) =>
      urls.every((url) => new URL(url).searchParams.get("nsfw") === "true"),
    );
    expect(
      calls.filter((call) => call[1]?.method === "DELETE").map((call) => requestHref(call[0])),
    ).toEqual([1, 2, 3].map((id) => `https://api.myanimelist.net/v2/manga/${id}/my_list_status`));
    expect(ctx.sleep).toHaveBeenCalledTimes(7);
  });

  it("dry-run reports the scan but never starts progress or writes", async () => {
    const ctx = setup(profile(), page([1]));
    expect(await wipeMalManga({ ...ctx, apply: false })).toMatchObject({ scanned: 1, deleted: 0 });
    expect(ctx.scanned).toHaveBeenCalled();
    expect(ctx.progress).not.toHaveBeenCalled();
    expect(ctx.fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not start progress for an empty list", async () => {
    const ctx = setup(profile(), page([]));
    expect(await wipeMalManga({ ...ctx, apply: true })).toMatchObject({ scanned: 0 });
    expect(ctx.progress).not.toHaveBeenCalled();
  });

  it("refuses to call a malformed list response empty", async () => {
    const ctx = setup(profile(), Response.json({ error: "bad response" }));
    await expect(wipeMalManga({ ...ctx, apply: true })).rejects.toThrow();
    expect(ctx.scanned).not.toHaveBeenCalled();
  });

  it("reports entries recreated during deletion instead of claiming success", async () => {
    const ctx = setup(profile(), page([1]), profile(), new Response(null), page([9]));
    await expect(wipeMalManga({ ...ctx, apply: true })).rejects.toThrow("1 manga remain (9)");
  });

  it("refuses an account switch after scanning", async () => {
    const ctx = setup(profile(), page([1]), Response.json({ id: 8, name: "someone-else" }));
    await expect(wipeMalManga({ ...ctx, apply: true })).rejects.toThrow("account changed");
    expect(ctx.fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops on failure and a new run deletes only surviving entries", async () => {
    const ctx = setup(
      profile(),
      page([1, 2]),
      profile(),
      new Response(null),
      new Response(null, { status: 403 }),
      profile(),
      page([2]),
      profile(),
      new Response(null),
      page([]),
    );
    await expect(wipeMalManga({ ...ctx, apply: true })).rejects.toThrow("HTTP 403");
    expect(await wipeMalManga({ ...ctx, apply: true })).toMatchObject({ scanned: 1, deleted: 1 });
    const deletes = vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deletes.map((call) => requestHref(call[0]))).toEqual(
      [1, 2, 2].map((id) => `https://api.myanimelist.net/v2/manga/${id}/my_list_status`),
    );
  });

  it.each([
    "https://evil.example/v2/users/@me/mangalist?offset=1000",
    "https://api.myanimelist.net/v2/users/another/mangalist?offset=1000",
  ])("rejects unexpected pagination URL %s", async (next) => {
    const ctx = setup(page([1], next));
    await expect(ctx.client.manga()).rejects.toThrow("Unexpected MAL pagination URL");
    expect(ctx.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects pagination loops", async () => {
    const ctx = setup(
      page([1], "https://api.myanimelist.net/v2/users/@me/mangalist?limit=1000&nsfw=true"),
    );
    await expect(ctx.client.manga()).rejects.toThrow("pagination repeated");
    expect(ctx.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("MAL manga updates", () => {
  it("PATCHes only supplied fields and preserves zero, false, and escaped text", async () => {
    const ctx = setup(Response.json({ status: "reading" }));
    await ctx.client.updateManga(1, {
      status: "reading",
      score: 0,
      is_rereading: false,
      num_chapters_read: 12,
      comments: "A&B = 漫画",
      tags: undefined,
    });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe("https://api.myanimelist.net/v2/manga/1/my_list_status");
    expect(call?.[1]?.method).toBe("PATCH");
    expect(call?.[1]?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(Object.fromEntries(new URLSearchParams(requestBodyText(call?.[1])))).toEqual({
      status: "reading",
      score: "0",
      is_rereading: "false",
      num_chapters_read: "12",
      comments: "A&B = 漫画",
    });
  });

  it("rejects invalid IDs and empty updates without making requests", async () => {
    const ctx = setup();
    await expect(ctx.client.updateManga(0, { status: "reading" })).rejects.toThrow(
      "Invalid MAL manga ID",
    );
    await expect(ctx.client.updateManga(1, {})).rejects.toThrow("at least one field");
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });
});

describe("MAL authentication and retries", () => {
  it("uses MAL's plain PKCE with fresh state and verifier", () => {
    const auth = createMalAuthorization("client");
    const params = new URL(auth.url).searchParams;
    expect(params.get("code_challenge_method")).toBe("plain");
    expect(params.get("code_challenge")).toBe(auth.verifier);
    expect(auth.verifier.length).toBeGreaterThanOrEqual(43);
    expect(params.get("redirect_uri")).toBe(MAL_REDIRECT_URI);
    expect(params.get("state")).toBe(auth.state);
    expect(createMalAuthorization("client").state).not.toBe(auth.state);
  });

  it("refreshes an expired session and persists rotated tokens before use", async () => {
    const ctx = setup(
      Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }),
      profile(),
    );
    const saveSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const client = createMalClient({
      session: { clientId: "client", accessToken: "old", refreshToken: "refresh", expiresAt: 0 },
      clientSecret: "secret",
      saveSession,
      sleep: ctx.sleep,
    });
    await client.profile();
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new", refreshToken: "rotated" }),
    );
    const calls = vi.mocked(fetch).mock.calls;
    expect(requestHref(calls[0]?.[0] ?? "")).toBe("https://myanimelist.net/v1/oauth2/token");
    expect(requestBodyText(calls[0]?.[1])).toContain("grant_type=refresh_token");
    expect(requestBodyText(calls[0]?.[1])).toContain("client_secret=secret");
    expect(calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer new" });
  });

  it("refreshes once on 401, then stops on another 401", async () => {
    const ctx = setup(
      new Response(null, { status: 401 }),
      Response.json({ access_token: "new", expires_in: 3600 }),
      new Response(null, { status: 401 }),
    );
    const saveSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const client = createMalClient({
      session: {
        clientId: "client",
        accessToken: "old",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3600_000,
      },
      saveSession,
      sleep: ctx.sleep,
    });
    await expect(client.profile()).rejects.toThrow("HTTP 401");
    expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "refresh" }));
    expect(ctx.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])("does not retry HTTP %s with a supplied access token", async (status) => {
    const ctx = setup(new Response(null, { status }));
    await expect(ctx.client.profile()).rejects.toThrow(`HTTP ${status}`);
    expect(ctx.fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After and bounds 5xx retries", async () => {
    const ctx = setup(
      new Response(null, { status: 429, headers: { "retry-after": "12" } }),
      profile(),
      ...Array.from({ length: 4 }, () => new Response(null, { status: 503 })),
    );
    await ctx.client.profile();
    expect(ctx.sleep).toHaveBeenCalledWith(12_000);
    await expect(ctx.client.deleteManga(1)).rejects.toThrow("HTTP 503");
    expect(ctx.fetcher).toHaveBeenCalledTimes(6);
  });

  it("stops rather than waiting an unbounded Retry-After", async () => {
    const ctx = setup(new Response(null, { status: 429, headers: { "retry-after": "9999" } }));
    await expect(ctx.client.profile()).rejects.toThrow("long retry delay");
    expect(ctx.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not leak malformed token payloads in errors", async () => {
    setup(Response.json({ access_token: "SECRET_TOKEN", expires_in: "SECRET_VALUE" }));
    await expect(requestMalTokens("client", undefined, new URLSearchParams())).rejects.toThrow(
      /^MAL returned an invalid token response\. Run login mal again\.$/,
    );
  });
});
