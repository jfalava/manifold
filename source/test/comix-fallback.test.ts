import { describe, expect, it } from "vitest";
import type { SourceManga } from "@paperback/types";

import type { JsonObject } from "@manifold/json";
import {
  chapterItemsFromCapture,
  isComixChapterId,
  pickComixMatch,
  rawComixChapterId,
  toSyncComixChapters,
} from "../src/ManifoldSource/comix-fallback.js";

const sourceManga: SourceManga = {
  mangaId: "anilist:132624",
  mangaInfo: {
    thumbnailUrl: "",
    synopsis: "",
    primaryTitle: "A Couple of Cuckoos",
    secondaryTitles: [],
    // SAFETY: intentional never-widen for exhaustive/test placeholder
    contentRating: "SAFE" as never,
    additionalInfo: {},
  },
};

describe("pickComixMatch", () => {
  it("prefers an exact normalized title match", () => {
    const items: JsonObject[] = [
      { hid: "aaa", title: "Cuckoos Guide" },
      { hid: "6glz", title: "A Couple of Cuckoos" },
    ];
    expect(pickComixMatch(items, ["A Couple of Cuckoos"])?.hid).toBe("6glz");
  });

  it("matches alt titles and falls back to partial inclusion", () => {
    const items: JsonObject[] = [
      { hid: "abc", title: "Something Else", altTitles: ["Kakkou no Iinazuke"] },
      { hid: "zzz", title: "A Couple of Cuckoo Sequel" },
    ];
    expect(pickComixMatch(items, ["Kakkou no Iinazuke"])?.hid).toBe("abc");
    expect(pickComixMatch(items, ["Couple of Cuckoo"])?.hid).toBe("zzz");
  });

  it("returns undefined when nothing matches", () => {
    expect(pickComixMatch([{ hid: "x", title: "Unrelated" } satisfies JsonObject], ["Cuckoos"])).toBeUndefined();
  });

  it("exactOnly skips fuzzy matches that plain mode would take", () => {
    const items: JsonObject[] = [{ hid: "zzz", title: "A Couple of Cuckoo Sequel" }];
    expect(pickComixMatch(items, ["A Couple of Cuckoos"])?.hid).toBe("zzz");
    expect(pickComixMatch(items, ["A Couple of Cuckoos"], true)).toBeUndefined();
  });
});

describe("chapterItemsFromCapture", () => {
  it("accepts a bare chapter array from captureViaSiteBundle unwrap", () => {
    const items = [{ id: "1", chapter: 1 }, { id: "2", chapter: 2 }];
    expect(chapterItemsFromCapture(items)).toEqual(items);
  });

  it("also accepts a residual { r: items } wrapper", () => {
    const items = [{ id: "9", chapter: 9 }];
    expect(chapterItemsFromCapture({ r: items })).toEqual(items);
  });

  it("returns empty for unrelated payloads", () => {
    expect(chapterItemsFromCapture(undefined)).toEqual([]);
    expect(chapterItemsFromCapture({ result: {} })).toEqual([]);
  });
});

describe("toSyncComixChapters", () => {
  it("prefixes chapter ids with the comix provenance marker", () => {
    const chapters = toSyncComixChapters(
      [
        { id: "8295088", chapter: 12, volume: 2 },
        { id: "8295089", chapter: 13 },
      ],
      sourceManga,
    );

    expect(chapters.map((chapter) => chapter.chapterId)).toEqual([
      "comix:8295088",
      "comix:8295089",
    ]);
    expect(chapters[0]?.chapNum).toBe(12);
    expect(chapters[0]?.volume).toBe(2);
    expect(chapters[0]?.additionalInfo?.["Comix chapter URL"]).toBe(
      "https://comix.to/chapter/8295088",
    );
  });

  it("round-trips through the raw id helpers", () => {
    expect(isComixChapterId("comix:8295088")).toBe(true);
    expect(isComixChapterId("df2e5603-uuid")).toBe(false);
    expect(rawComixChapterId("comix:8295088")).toBe("8295088");
  });
});
