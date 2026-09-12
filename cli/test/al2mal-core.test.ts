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
import { describe, expect, it, vi } from "vitest";

import {
  createMalTitleSearch,
  malSearchQuery,
  malSearchQueryOk,
  malUpdateForAniList,
  matchAniListToMal,
  runAl2mal,
  type Al2malSearch,
} from "../src/al2mal-core";
import type { AniListEntry } from "../src/anilist";

const entry = (
  partial: Partial<AniListEntry> & Pick<AniListEntry, "mediaId" | "title" | "status">,
): AniListEntry => partial;

describe("malUpdateForAniList", () => {
  it.each([
    ["CURRENT", { status: "reading", is_rereading: false }],
    ["PLANNING", { status: "plan_to_read", is_rereading: false }],
    ["COMPLETED", { status: "completed", is_rereading: false }],
    ["DROPPED", { status: "dropped", is_rereading: false }],
    ["PAUSED", { status: "on_hold", is_rereading: false }],
    ["REPEATING", { status: "reading", is_rereading: true }],
  ] as const)("maps %s", (status, expected) => {
    expect(malUpdateForAniList({ status, progress: 4 }, { includeProgress: true })).toEqual({
      ...expected,
      num_chapters_read: 4,
    });
  });

  it("omits chapter progress when skip-progress is requested", () => {
    expect(
      malUpdateForAniList({ status: "CURRENT", progress: 12 }, { includeProgress: false }),
    ).toEqual({ status: "reading", is_rereading: false });
  });

  it("rejects unknown AniList statuses", () => {
    expect(
      malUpdateForAniList({ status: "WATCHING", progress: undefined }, { includeProgress: true }),
    ).toBeUndefined();
  });
});

describe("malSearchQuery", () => {
  it("accepts 3–64 code points and clamps longer titles", () => {
    expect(malSearchQueryOk("")).toBe(false);
    expect(malSearchQueryOk("ab")).toBe(false);
    expect(malSearchQueryOk("abc")).toBe(true);
    expect(malSearchQueryOk("あい")).toBe(false);
    expect(malSearchQueryOk("あいう")).toBe(true);
    expect(malSearchQueryOk("x".repeat(64))).toBe(true);
    expect(malSearchQueryOk("x".repeat(65))).toBe(false);
    expect(malSearchQuery("x".repeat(70))).toBe("x".repeat(64));
    expect(malSearchQuery("ab")).toBeUndefined();
  });
});

describe("createMalTitleSearch", () => {
  const instant = vi.fn(async () => undefined);

  it("does not log and returns empty for short q without fetching", async () => {
    const fetcher = vi.fn();
    const search = createMalTitleSearch("client", fetcher, instant);
    await expect(search("ab")).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(instant).not.toHaveBeenCalled();
  });

  it("throws quietly (no console) on HTTP 400 so the bar can count errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "invalid q", error: "bad_request" }), {
          status: 400,
        }),
    );
    const search = createMalTitleSearch("client", fetcher, instant);
    await expect(search("Some Title")).rejects.toThrow("MAL title search HTTP 400");
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("parses node + alternative_titles on success", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [
          {
            node: {
              id: 9,
              title: "Berserk",
              alternative_titles: { en: "Berserk", ja: "ベルセルク", synonyms: ["Berserk Max"] },
            },
          },
        ],
      }),
    );
    const search = createMalTitleSearch("client", fetcher, instant);
    await expect(search("Berserk")).resolves.toEqual([
      {
        id: 9,
        title: "Berserk",
        aliases: ["Berserk", "ベルセルク", "Berserk Max"],
      },
    ]);
  });

  it("spaces real searches by 1.5s after the first (same floor as createMalClient)", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] }));
    const sleep = vi.fn(async () => undefined);
    const search = createMalTitleSearch("client", fetcher, sleep);
    await search("One Piece");
    await search("Berserk");
    await search("ab"); // skipped — no HTTP, no extra sleep
    await search("Vinland Saga");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_500);
  });

  it("retries 429 with backoff before giving up", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(Response.json({ data: [] }));
    const sleep = vi.fn(async () => undefined);
    const search = createMalTitleSearch("client", fetcher, sleep);
    await expect(search("One Piece")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_500);
  });
});

describe("matchAniListToMal", () => {
  const search: Al2malSearch = vi.fn(async () => []);

  it("prefers AniList idMal without searching", async () => {
    const result = await matchAniListToMal(
      entry({ mediaId: 1, title: "One", status: "CURRENT", malId: "99", progress: 3 }),
      search,
      { includeProgress: true },
    );
    expect(result).toMatchObject({
      kind: "matched",
      value: {
        malId: 99,
        method: "idMal",
        update: { status: "reading", is_rereading: false, num_chapters_read: 3 },
      },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts a unique exact title match", async () => {
    const titleSearch: Al2malSearch = async () => [
      { id: 5, title: "Berserk", aliases: ["ベルセルク"] },
      { id: 6, title: "Berserk Max", aliases: [] },
    ];
    const result = await matchAniListToMal(
      entry({ mediaId: 2, title: "Berserk", status: "COMPLETED", titles: ["Berserk"] }),
      titleSearch,
      { includeProgress: false },
    );
    expect(result).toMatchObject({
      kind: "matched",
      value: {
        malId: 5,
        method: "title-exact",
        update: { status: "completed", is_rereading: false },
      },
    });
  });

  it("leaves conflicting exact titles unmatched", async () => {
    const titleSearch: Al2malSearch = async () => [
      { id: 1, title: "One Piece", aliases: [] },
      { id: 2, title: "One Piece", aliases: ["OP"] },
    ];
    const result = await matchAniListToMal(
      entry({ mediaId: 3, title: "One Piece", status: "CURRENT" }),
      titleSearch,
      { includeProgress: true },
    );
    expect(result).toMatchObject({
      kind: "unmatched",
      value: { reason: "Ambiguous or weak MAL title match" },
    });
  });

  it("accepts a unique partial title when no exact hit", async () => {
    const titleSearch: Al2malSearch = async () => [{ id: 8, title: "Vinland Saga", aliases: [] }];
    const result = await matchAniListToMal(
      entry({ mediaId: 4, title: "Vinland", status: "PAUSED" }),
      titleSearch,
      { includeProgress: false },
    );
    expect(result).toMatchObject({
      kind: "matched",
      value: {
        malId: 8,
        method: "title-partial",
        update: { status: "on_hold", is_rereading: false },
      },
    });
  });

  it("does not call MAL search when no title is usable as q", async () => {
    const titleSearch = vi.fn(async () => [{ id: 1, title: "X", aliases: [] }]);
    const result = await matchAniListToMal(
      entry({ mediaId: 5, title: "OK", status: "CURRENT", titles: ["OK", "A"] }),
      titleSearch,
      { includeProgress: false },
    );
    expect(titleSearch).not.toHaveBeenCalled();
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") {
      expect(result.value.reason).toContain("3–64 characters");
    }
  });

  it("treats a thrown title search as unmatched instead of aborting", async () => {
    const titleSearch: Al2malSearch = async () => {
      throw new Error('Canonical provider returned HTTP 400: body={"message":"invalid q"}');
    };
    const result = await matchAniListToMal(
      entry({ mediaId: 6, title: "Some Long Title", status: "CURRENT" }),
      titleSearch,
      { includeProgress: false },
    );
    expect(result.kind).toBe("unmatched");
    if (result.kind === "unmatched") {
      expect(result.value.reason).toContain("MAL title search failed");
    }
  });
});

describe("runAl2mal", () => {
  it("dry-run never writes", async () => {
    const updateManga = vi.fn();
    const report = await runAl2mal({
      entries: [entry({ mediaId: 1, title: "A", status: "CURRENT", malId: "10", progress: 2 })],
      search: async () => [],
      client: { updateManga },
      dryRun: true,
      includeProgress: true,
    });
    expect(report).toMatchObject({
      scanned: 1,
      matched: [{ malId: 10 }],
      written: 0,
      failed: 0,
      dryRun: true,
    });
    expect(updateManga).not.toHaveBeenCalled();
  });

  it("apply PATCHes status, reread, and chapter progress", async () => {
    const updateManga = vi.fn(async () => undefined);
    const report = await runAl2mal({
      entries: [
        entry({ mediaId: 1, title: "A", status: "REPEATING", malId: "10", progress: 7 }),
        entry({ mediaId: 2, title: "Missing", status: "CURRENT" }),
      ],
      search: async () => [],
      client: { updateManga },
      dryRun: false,
      includeProgress: true,
    });
    expect(updateManga).toHaveBeenCalledTimes(1);
    expect(updateManga).toHaveBeenCalledWith(10, {
      status: "reading",
      is_rereading: true,
      num_chapters_read: 7,
    });
    expect(report).toMatchObject({
      scanned: 2,
      matched: [{ malId: 10 }],
      unmatched: [{ mediaId: 2 }],
      written: 1,
      failed: 0,
      dryRun: false,
    });
  });

  it("records per-entry write failures without aborting the rest", async () => {
    const updateManga = vi.fn(async (id: number) => {
      if (id === 1) {
        throw new Error("HTTP 500");
      }
    });
    const report = await runAl2mal({
      entries: [
        entry({ mediaId: 1, title: "A", status: "CURRENT", malId: "1" }),
        entry({ mediaId: 2, title: "B", status: "DROPPED", malId: "2" }),
      ],
      search: async () => [],
      client: { updateManga },
      dryRun: false,
      includeProgress: false,
    });
    expect(report.written).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.matched[0]?.error).toContain("HTTP 500");
    expect(report.matched[1]?.error).toBeUndefined();
  });
});
