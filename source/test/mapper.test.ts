import { ContentRating, type SourceManga } from "@paperback/types";
import { describe, expect, it } from "vitest";
import {
  isTitleMatch,
  toCanonicalSearchResult,
  toMangaDexChapters,
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

  it("keeps hosted MangaDex chapters and drops external or empty entries", () => {
    const sourceManga: SourceManga = {
      mangaId: entry.id,
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: entry.title,
        secondaryTitles: [],
        contentRating: ContentRating.EVERYONE,
        additionalInfo: {},
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
      pageCount: 20,
    }, {
      id: "empty-chapter",
      mangaId: "manga-1",
      chapterNumber: 3,
      language: "en",
      pageCount: 0,
    }]);

    expect(chapters).toEqual([expect.objectContaining({
      chapterId: "chapter-1",
      sourceManga,
      chapNum: 1,
      additionalInfo: expect.objectContaining({ "manifold provider": "mangadex" }),
    })]);
  });
});
