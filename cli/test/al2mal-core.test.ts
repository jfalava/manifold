import { describe, expect, it, vi } from "vitest";

import {
  malUpdateForAniList,
  matchAniListToMal,
  runAl2mal,
  type Al2malSearch,
} from "../src/al2mal-core";
import type { AniListEntry } from "../src/anilist";

const entry = (partial: Partial<AniListEntry> & Pick<AniListEntry, "mediaId" | "title" | "status">): AniListEntry =>
  partial;

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
    expect(malUpdateForAniList({ status: "CURRENT", progress: 12 }, { includeProgress: false }))
      .toEqual({ status: "reading", is_rereading: false });
  });

  it("rejects unknown AniList statuses", () => {
    expect(malUpdateForAniList({ status: "WATCHING" }, { includeProgress: true })).toBeUndefined();
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
      value: { malId: 5, method: "title-exact", update: { status: "completed", is_rereading: false } },
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
    const titleSearch: Al2malSearch = async () => [
      { id: 8, title: "Vinland Saga", aliases: [] },
    ];
    const result = await matchAniListToMal(
      entry({ mediaId: 4, title: "Vinland", status: "PAUSED" }),
      titleSearch,
      { includeProgress: false },
    );
    expect(result).toMatchObject({
      kind: "matched",
      value: { malId: 8, method: "title-partial", update: { status: "on_hold", is_rereading: false } },
    });
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
    expect(report).toMatchObject({ scanned: 1, matched: [{ malId: 10 }], written: 0, failed: 0, dryRun: true });
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
      if (id === 1) {throw new Error("HTTP 500");}
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
