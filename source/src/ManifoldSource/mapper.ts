import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type MangaInfo,
  type SourceManga,
} from "@paperback/types";
import type { CanonicalSearchResult } from "@manifold/canonical";
import { toCanonicalSearchResult } from "@manifold/paperback-runtime";

export { toCanonicalSearchResult };
import type {
  MangaDexChapter,
  MangaDexChapterDetails,
  MangaDexManga,
} from "@manifold/mangadex";

export type ReadingProvider = "mangadex" | "comix";

export const providerFromInfo = (
  sourceManga: SourceManga,
): { readonly provider: ReadingProvider; readonly externalId: string } | undefined => {
  const info = sourceManga.mangaInfo.additionalInfo;
  const provider = info?.["manifold provider"];
  const externalId = info?.["manifold provider ID"];
  if ((provider !== "mangadex" && provider !== "comix") || !externalId) {return undefined;}
  return { provider, externalId };
};

const canonicalInfo = (entry: CanonicalSearchResult): MangaInfo => ({
  thumbnailUrl: entry.metadata?.coverUrl ?? "",
  synopsis: entry.metadata?.description ?? "",
  primaryTitle: entry.title,
  secondaryTitles: [...entry.aliases].filter((title) => title !== entry.title),
  contentRating: ContentRating.EVERYONE,
  status: entry.metadata?.status,
  rating: entry.score,
  additionalInfo: {
    "Canonical ID": entry.id,
    "Canonical provider": entry.provider,
    "Canonical provider ID": entry.providerId,
  },
});

/** Registry-canonical SourceManga with no reading provider stamped yet. */
export const toCanonicalSourceManga = (
  entry: CanonicalSearchResult,
): SourceManga => ({
  mangaId: entry.id,
  mangaInfo: canonicalInfo(entry),
});

export const toMangaDexSourceManga = (
  entry: CanonicalSearchResult,
  manga: MangaDexManga,
): SourceManga => ({
  mangaId: entry.id,
  mangaInfo: {
    ...canonicalInfo(entry),
    thumbnailUrl: manga.coverUrl ?? entry.metadata?.coverUrl ?? "",
    synopsis: manga.description ?? entry.metadata?.description ?? "",
    primaryTitle: entry.title || manga.title,
    secondaryTitles: [...new Set([manga.title, ...manga.altTitles, ...entry.aliases])]
      .filter((title) => title !== entry.title),
    status: manga.status ?? entry.metadata?.status,
    additionalInfo: {
      ...canonicalInfo(entry).additionalInfo,
      "manifold provider": "mangadex",
      "manifold provider ID": manga.id,
      "manifold provider title": manga.title,
    },
  },
});

export const toMangaDexChapters = (
  sourceManga: SourceManga,
  chapters: readonly MangaDexChapter[],
): Chapter[] => chapters
  .filter((chapter) => chapter.pageCount !== 0 || chapter.externalUrl !== undefined)
  .map((chapter) => ({
    chapterId: chapter.id,
    sourceManga,
    langCode: chapter.language,
    chapNum: chapter.chapterNumber ?? 0,
    ...(chapter.title ? { title: chapter.title } : {}),
    ...(chapter.volumeNumber === undefined ? {} : { volume: chapter.volumeNumber }),
    ...(chapter.publishedAt === undefined ? {} : { publishDate: new Date(chapter.publishedAt) }),
    additionalInfo: {
      "manifold provider": "mangadex",
      "manifold provider ID": chapter.id,
      ...(chapter.externalUrl ? { "manifold external URL": chapter.externalUrl } : {}),
    },
  }));

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character] ?? character));

export const toMangaDexExternalChapterDetails = (
  chapter: Chapter,
  externalUrl: string,
): ChapterDetails => ({
  id: chapter.chapterId,
  mangaId: chapter.sourceManga.mangaId,
  type: "html",
  html: `<p>This chapter is hosted outside MangaDex.</p><p><a href="${escapeHtml(externalUrl)}">Open chapter</a></p>`,
});

export const toMangaDexChapterDetails = (
  chapter: Chapter,
  details: MangaDexChapterDetails,
): ChapterDetails => ({
  id: chapter.chapterId,
  mangaId: chapter.sourceManga.mangaId,
  type: "images",
  pages: details.pages.map((page) => page.url),
});

export const buildMangaDexSourceManga = (
  manga: MangaDexManga,
  entryId: string | null,
): SourceManga => ({
  mangaId: entryId ?? `mangadex:${manga.id}`,
  mangaInfo: {
    thumbnailUrl: manga.coverUrl ?? "",
    synopsis: manga.description ?? "",
    primaryTitle: manga.title,
    secondaryTitles: [...manga.altTitles].filter((title) => title !== manga.title),
    contentRating: ContentRating.MATURE,
    status: manga.status,
    additionalInfo: {
      ...(entryId ? { "Canonical ID": entryId } : {}),
      "manifold provider": "mangadex",
      "manifold provider ID": manga.id,
      "manifold provider title": manga.title,
    },
  },
});

export const toComixSourceManga = (
  sourceManga: SourceManga,
  externalId: string,
): SourceManga => ({
  ...sourceManga,
  mangaInfo: {
    ...sourceManga.mangaInfo,
    additionalInfo: {
      ...sourceManga.mangaInfo.additionalInfo,
      "manifold provider": "comix",
      "manifold provider ID": externalId,
    },
  },
});

export const withProviderInfo = (
  sourceManga: SourceManga,
  provider: ReadingProvider,
  externalId: string,
): SourceManga => ({
  ...sourceManga,
  mangaInfo: {
    ...sourceManga.mangaInfo,
    additionalInfo: {
      ...sourceManga.mangaInfo.additionalInfo,
      "manifold provider": provider,
      "manifold provider ID": externalId,
    },
  },
});

export const normalizeTitle = (title: string): string =>
  title.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export const isTitleMatch = (
  canonical: CanonicalSearchResult,
  candidate: string,
): boolean => {
  const normalized = normalizeTitle(candidate);
  return [canonical.title, ...canonical.aliases]
    .map(normalizeTitle)
    .some((title) => title === normalized || title.includes(normalized) || normalized.includes(title));
};
