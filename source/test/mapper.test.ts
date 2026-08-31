import { describe, expect, it } from "vitest";
import {
  isTitleMatch,
  toCanonicalSearchResult,
  toMangaDexChapters,
  toMangaDexExternalChapterDetails,
} from "../src/ManifoldSource/mapper";

const entry = {
  id: "anilist:1",
  provider: "anilist" as const,
  providerId: "1",
  title: "Fullmetal Alchemist",
  aliases: ["Fullmetal Alchemist", "Hagane no Renkinjutsushi"],
  score: 0.95,
};

describe("manifold Paperback mapping", () => {
  it("keeps the canonical identity as the Paperback manga ID", () => {
    expect(toCanonicalSearchResult(entry)).toMatchObject({
      mangaId: "anilist:1",
      title: "Fullmetal Alchemist",
      metadata: entry,
    });
  });

  it("matches provider titles through canonical aliases", () => {
    expect(isTitleMatch(entry, "Hagane no Renkinjutsushi")).toBe(true);
    expect(isTitleMatch(entry, "A different title")).toBe(false);
  });

  it("keeps MangaDex chapter IDs while retaining the canonical source manga", () => {
    const sourceManga = {
      mangaId: entry.id,
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: entry.title,
        secondaryTitles: [],
        contentRating: "SAFE" as const,
      },
    };
    const chapters = toMangaDexChapters(sourceManga, [{
      id: "chapter-1",
      mangaId: "manga-1",
      chapterNumber: 1,
      language: "en",
      pageCount: 20,
    }, {
      id: "external-chapter",
      mangaId: "manga-1",
      chapterNumber: 2,
      language: "en",
      externalUrl: "https://mangaplus.shueisha.co.jp/viewer/example",
      pageCount: 0,
    }]);

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      chapterId: "chapter-1",
      sourceManga,
      chapNum: 1,
      additionalInfo: { "manifold provider": "mangadex" },
    });
    expect(chapters[1]).toMatchObject({
      chapterId: "external-chapter",
      additionalInfo: {
        "manifold external URL": "https://mangaplus.shueisha.co.jp/viewer/example",
      },
    });

    expect(toMangaDexExternalChapterDetails(
      chapters[1],
      "https://mangaplus.shueisha.co.jp/viewer/example?a=1&b=2",
    )).toEqual({
      id: "external-chapter",
      mangaId: "anilist:1",
      type: "html",
      html: '<p>This chapter is hosted outside MangaDex.</p><p><a href="https://mangaplus.shueisha.co.jp/viewer/example?a=1&amp;b=2">Open chapter</a></p>',
    });
  });
});
