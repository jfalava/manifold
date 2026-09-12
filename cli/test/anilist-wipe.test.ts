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
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  deleteActivity,
  deleteEntry,
  retryAfterMs,
  selectWipeActivities,
  type Activity,
} from "../src/anilist-wipe";

const mangaListActivity = (id: number): Activity => ({
  type: "MANGA_LIST",
  id,
  status: "reading",
  progress: "12",
  mediaTitle: "Some Manga",
});

const textActivity = (id: number, text: string): Activity => ({ type: "TEXT", id, text });

const jsonResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } });

describe("anilist wipe activity selection", () => {
  it("targets typed MANGA_LIST activities by default", () => {
    const activities = [mangaListActivity(1), mangaListActivity(2)];
    expect(selectWipeActivities(activities)).toEqual(activities);
  });

  it("never targets TEXT activities by keyword match, even obvious manga prose", () => {
    const activities = [
      textActivity(1, "Read the latest manga chapter"),
      textActivity(2, "Volume 5 arrived today"),
      textActivity(3, "Picking up the light novel series"),
      textActivity(4, "New manhwa recommendation"),
    ];
    expect(selectWipeActivities(activities)).toEqual([]);
  });

  it("excludes unrelated prose and anime posts by default", () => {
    const activities = [
      textActivity(1, "already watched the anime, great show"),
      textActivity(2, "Reading progress: finished this series!"),
      textActivity(3, "I read the news this morning"),
    ];
    expect(selectWipeActivities(activities)).toEqual([]);
  });

  it("never targets unknown activity types, including anime list activity", () => {
    // SAFETY: test fixture intentionally simulates an out-of-union activity
    // type (ANIME_LIST) to prove selection drops unknown types; the fixture
    // JSON is fully controlled here.
    const animeListActivity = JSON.parse(
      '{"type":"ANIME_LIST","id":1,"status":"watching"}',
    ) as Activity;
    expect(selectWipeActivities([animeListActivity])).toEqual([]);
  });

  it("includes TEXT activities only with the explicit includeTextActivities opt-in", () => {
    const activities = [
      mangaListActivity(1),
      textActivity(2, "already watched the anime, great show"),
    ];
    const selected = selectWipeActivities(activities, { includeTextActivities: true });
    expect(selected).toHaveLength(2);
    expect(selected).toEqual(activities);
  });
});

describe("anilist wipe deletion envelopes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (response: Response): ReturnType<typeof vi.fn> => {
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };

  const stubFetchSequence = (responses: Response[]): ReturnType<typeof vi.fn> => {
    if (responses.length === 0) {
      throw new Error("stubFetchSequence needs at least one response");
    }
    const fetcher = vi.fn();
    for (const response of responses.slice(0, -1)) {
      fetcher.mockResolvedValueOnce(response);
    }
    fetcher.mockResolvedValue(responses[responses.length - 1]);
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };

  const rateLimited = (): Response =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    });

  describe("retryAfterMs", () => {
    it("parses retry-after seconds into milliseconds", () => {
      expect(retryAfterMs(rateLimited())).toBe(0);
      expect(
        retryAfterMs(new Response("x", { status: 429, headers: { "retry-after": "120" } })),
      ).toBe(120_000);
    });

    it("falls back to 60s on missing or malformed headers", () => {
      expect(retryAfterMs(new Response("x", { status: 429 }))).toBe(60_000);
      expect(
        retryAfterMs(new Response("x", { status: 429, headers: { "retry-after": "soon" } })),
      ).toBe(60_000);
    });
  });

  describe("deleteEntry", () => {
    it("succeeds only on HTTP 200 with no errors and deleted:true", async () => {
      stubFetch(
        jsonResponse(200, JSON.stringify({ data: { DeleteMediaListEntry: { deleted: true } } })),
      );
      await expect(deleteEntry("token", 1)).resolves.toBe(true);
    });

    it("fails on non-HTTP-200 responses", async () => {
      stubFetch(jsonResponse(500, JSON.stringify({ errors: [{ message: "Internal" }] })));
      await expect(deleteEntry("token", 1)).resolves.toBe(false);
    });

    it("fails when the HTTP 200 body carries GraphQL errors", async () => {
      stubFetch(
        jsonResponse(
          200,
          JSON.stringify({
            errors: [{ message: "Not authenticated" }],
            data: null,
          }),
        ),
      );
      await expect(deleteEntry("token", 1)).resolves.toBe(false);
    });

    it("fails when deleted:false is returned", async () => {
      stubFetch(
        jsonResponse(200, JSON.stringify({ data: { DeleteMediaListEntry: { deleted: false } } })),
      );
      await expect(deleteEntry("token", 1)).resolves.toBe(false);
    });

    it("fails on a malformed envelope", async () => {
      stubFetch(jsonResponse(200, JSON.stringify({ data: {} })));
      await expect(deleteEntry("token", 1)).resolves.toBe(false);
    });

    it("retries 429s with the shared rate-limit path, then succeeds", async () => {
      const fetcher = stubFetchSequence([
        rateLimited(),
        jsonResponse(200, JSON.stringify({ data: { DeleteMediaListEntry: { deleted: true } } })),
      ]);
      await expect(deleteEntry("token", 1)).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("gives up after bounded 429 retries instead of recursing forever", async () => {
      const fetcher = stubFetchSequence([
        rateLimited(),
        rateLimited(),
        rateLimited(),
        rateLimited(),
        rateLimited(),
        rateLimited(),
        jsonResponse(200, JSON.stringify({ data: { DeleteMediaListEntry: { deleted: true } } })),
      ]);
      await expect(deleteEntry("token", 1)).resolves.toBe(false);
      // 1 initial attempt + 5 retries; the trailing success is never reached.
      expect(fetcher).toHaveBeenCalledTimes(6);
    });
  });

  describe("deleteActivity", () => {
    it("succeeds only on HTTP 200 with no errors and deleted:true", async () => {
      stubFetch(jsonResponse(200, JSON.stringify({ data: { DeleteActivity: { deleted: true } } })));
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: true,
        alreadyDeleted: false,
      });
    });

    it("fails when the HTTP 200 body carries GraphQL errors", async () => {
      stubFetch(
        jsonResponse(
          200,
          JSON.stringify({
            errors: [{ message: "Not authenticated" }],
            data: null,
          }),
        ),
      );
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: false,
        alreadyDeleted: false,
      });
    });

    it("fails when deleted:false is returned", async () => {
      stubFetch(
        jsonResponse(200, JSON.stringify({ data: { DeleteActivity: { deleted: false } } })),
      );
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: false,
        alreadyDeleted: false,
      });
    });

    it("fails on non-HTTP-200 responses", async () => {
      stubFetch(jsonResponse(500, "oops"));
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: false,
        alreadyDeleted: false,
      });
    });

    it("treats the invalid-id 400 as already deleted", async () => {
      stubFetch(
        jsonResponse(
          400,
          JSON.stringify({
            errors: [{ message: "The selected id is invalid" }],
          }),
        ),
      );
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: true,
        alreadyDeleted: true,
      });
    });

    it("fails on other 400 responses", async () => {
      stubFetch(jsonResponse(400, JSON.stringify({ errors: [{ message: "Bad request" }] })));
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: false,
        alreadyDeleted: false,
      });
    });

    it("retries a 429 in a loop instead of recursing, then succeeds", async () => {
      const fetcher = stubFetchSequence([
        rateLimited(),
        jsonResponse(200, JSON.stringify({ data: { DeleteActivity: { deleted: true } } })),
      ]);
      await expect(deleteActivity("token", 1)).resolves.toEqual({
        success: true,
        alreadyDeleted: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});
