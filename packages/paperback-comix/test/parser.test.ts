/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
import { describe, expect, it } from "vitest";
import {
  hashIdFromMangaId,
  mangaIdFromItem,
  pageItems,
  paginationFromPayload,
  resultItems,
  toChapter,
  toChapterDetails,
  toSearchResult,
  toSourceManga,
} from "../src/parser.js";
import { chaptersFromWebView, pagesFromWebView } from "../src/webview.js";
import { comixSearchUrl, resolveComixUrl } from "../src/url.js";

describe("Comix Paperback parser", () => {
  const manga = {
    hid: "abc123",
    slug: "example-title",
    url: "/title/abc123-example-title",
    title: "Example title",
    altTitles: ["Example"],
    synopsis: "A test synopsis",
    poster: { medium: "https://img.example/cover.jpg" },
    authors: [{ title: "Author" }],
    artists: [{ title: "Artist" }],
    genres: [{ title: "Action" }],
    status: "ongoing",
    year: 2026,
  } as const;

  it("normalizes Comix title IDs", () => {
    expect(mangaIdFromItem(manga)).toBe("abc123-example-title");
    expect(hashIdFromMangaId("abc123-example-title")).toBe("abc123");
  });

  it("maps API result envelopes to Paperback models", () => {
    const payload = {
      result: {
        items: [manga],
        pagination: { current_page: 1, last_page: 2 },
      },
    };
    const sourceManga = toSourceManga(manga);
    const chapter = toChapter({ id: "chapter-1", chapter: "1", title: "Start" }, sourceManga);

    expect(resultItems(payload)).toHaveLength(1);
    expect(paginationFromPayload(payload)).toEqual({ currentPage: 1, lastPage: 2 });
    expect(toSearchResult(manga)).toMatchObject({
      mangaId: "abc123-example-title",
      title: "Example title",
      imageUrl: "https://img.example/cover.jpg",
    });
    expect(sourceManga.mangaInfo.author).toBe("Author");
    expect(chapter.chapNum).toBe(1);
  });

  it("normalizes chapter pages with a relative base URL", () => {
    const sourceManga = toSourceManga(manga);
    const chapter = toChapter({ id: "chapter-1", chapter: 1 }, sourceManga);
    const payload = {
      pages: {
        baseUrl: "https://cdn.example/images/",
        items: [{ url: "page-1.jpg" }, { url: "https://cdn.example/page-2.jpg" }],
      },
    };

    expect(pageItems(payload)).toEqual([
      { url: "https://cdn.example/images/page-1.jpg" },
      { url: "https://cdn.example/page-2.jpg" },
    ]);
    expect(toChapterDetails(payload, chapter)).toMatchObject({
      type: "images",
      pages: ["https://cdn.example/images/page-1.jpg", "https://cdn.example/page-2.jpg"],
    });
  });

  it("reads browser-rendered chapter and page results", () => {
    expect(
      chaptersFromWebView({
        chapters: [{ url: "https://comix.to/title/example/123-chapter-1", title: "Chapter 1" }],
      }),
    ).toEqual([{ url: "https://comix.to/title/example/123-chapter-1", title: "Chapter 1" }]);
    expect(pagesFromWebView({ pages: ["https://cdn.example/i/page-1.jpg"] })).toEqual([
      "https://cdn.example/i/page-1.jpg",
    ]);
  });

  it("builds Comix URLs without relying on Paperback's missing URL global", () => {
    expect(comixSearchUrl("Haimiya senpai", 2)).toBe(
      "https://comix.to/api/v1/manga?keyword=Haimiya%20senpai&page=2",
    );
    expect(resolveComixUrl("/chapter/example")).toBe("https://comix.to/chapter/example");
    expect(resolveComixUrl("https://comix.to/chapter/example")).toBe(
      "https://comix.to/chapter/example",
    );
  });
});
