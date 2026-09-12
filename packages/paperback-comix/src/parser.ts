/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type MangaInfo,
  type SearchResultItem,
  type SourceManga,
} from "@paperback/types";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";

export type { JsonObject };

/** Parsed payload from a Comix WebView inject or site-bundle capture. */
export type ComixCaptureBody = JsonValue;

export type ComixPagination = {
  readonly currentPage?: number;
  readonly lastPage?: number;
};

export type ComixPage = {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
};

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined;

const asArray = (value: JsonValue | undefined): readonly JsonValue[] =>
  isJsonArray(value) ? value : [];

const first = <T>(...values: readonly T[]): T | undefined => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
};

const asString = (value: JsonValue | undefined, fallback = ""): string =>
  isString(value) ? value : isFiniteNumber(value) ? String(value) : fallback;

const asNumber = (value: JsonValue | undefined): number | undefined => {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (!isString(value)) {
    return undefined;
  }
  const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asDate = (value: JsonValue | undefined): Date | undefined => {
  if (!isString(value) && !isFiniteNumber(value)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
};

const titleFromUrl = (value: string): string => {
  const withoutPrefix = value.replace(/^\/title\//, "");
  return withoutPrefix.split("/")[0] ?? withoutPrefix;
};

export const mangaIdFromItem = (item: JsonObject): string => {
  const url = asString(item.url);
  if (url) {
    return titleFromUrl(url);
  }

  const hashId = asString(first(item.hid, item.hash_id));
  const slug = asString(item.slug);
  return slug ? `${hashId}-${slug}` : hashId;
};

export const hashIdFromMangaId = (mangaId: string): string => mangaId.split("-", 1)[0] ?? mangaId;

const posterUrl = (item: JsonObject): string => {
  const poster = asObject(item.poster);
  return asString(first(poster?.large, poster?.medium, poster?.small, item.cover));
};

const contentRatingFromItem = (item: JsonObject): ContentRating => {
  const rating = asString(first(item.contentRating, item.content_rating)).toLowerCase();
  if (item.is_nsfw === true || rating === "nsfw" || rating === "adult") {
    return ContentRating.ADULT;
  }
  if (rating === "suggestive" || rating === "mature") {
    return ContentRating.MATURE;
  }
  return ContentRating.EVERYONE;
};

const joinedTitles = (value: JsonValue | undefined): string[] =>
  asArray(value)
    .map((title) => {
      if (isString(title)) {
        return title;
      }
      const object = asObject(title);
      return asString(first(object?.title, object?.name));
    })
    .filter(Boolean);

const joinedNames = (value: JsonValue | undefined): string | undefined => {
  const names = joinedTitles(value);
  return names.length > 0 ? names.join(", ") : undefined;
};

const itemGenres = (item: JsonObject): string[] =>
  asArray(item.genres)
    .map((genre) => {
      if (isString(genre)) {
        return genre;
      }
      const object = asObject(genre);
      return asString(first(object?.title, object?.name));
    })
    .filter(Boolean);

const synopsis = (item: JsonObject): string =>
  asString(first(item.synopsis, item.description, item.summary));

const toMangaInfo = (item: JsonObject): MangaInfo => {
  const genres = itemGenres(item);
  const author = joinedNames(item.authors);
  const artist = joinedNames(item.artists);
  const score = asNumber(first(item.ratedAvg, item.rated_avg, item.rating));
  const year = asString(item.year);

  return {
    thumbnailUrl: posterUrl(item),
    synopsis: synopsis(item),
    primaryTitle: asString(first(item.title, item.name), "Untitled"),
    secondaryTitles: joinedTitles(first(item.altTitles, item.alt_titles)),
    contentRating: contentRatingFromItem(item),
    status: asString(item.status) || undefined,
    author,
    artist,
    rating: score,
    tagGroups:
      genres.length > 0
        ? [{ id: "genres", title: "Genres", tags: genres.map((id) => ({ id, title: id })) }]
        : undefined,
    additionalInfo: {
      ...(asString(item.type) && { Type: asString(item.type) }),
      ...(year && { Year: year }),
      ...(asString(first(item.originalLanguage, item.original_language)) && {
        "Original language": asString(first(item.originalLanguage, item.original_language)),
      }),
    },
  };
};

export const toSourceManga = (item: JsonObject): SourceManga => ({
  mangaId: mangaIdFromItem(item),
  mangaInfo: toMangaInfo(item),
});

export const toSearchResult = (item: JsonObject): SearchResultItem => ({
  mangaId: mangaIdFromItem(item),
  title: asString(first(item.title, item.name), "Untitled"),
  subtitle: synopsis(item) || undefined,
  imageUrl: posterUrl(item),
  contentRating: contentRatingFromItem(item),
});

const resultObject = (payload: JsonValue): JsonObject => {
  const root = asObject(payload);
  const result = asObject(root?.result);
  return result ?? root ?? {};
};

export const resultItems = (payload: JsonValue): readonly JsonObject[] => {
  const result = resultObject(payload);
  const items = asArray(first(result.items, result.data));
  return items.filter(isJsonObject);
};

export const paginationFromPayload = (payload: JsonValue): ComixPagination => {
  const result = resultObject(payload);
  const pagination = asObject(result.pagination) ?? asObject(result.meta);
  return {
    currentPage: asNumber(
      first(pagination?.current_page, pagination?.currentPage, pagination?.page),
    ),
    lastPage: asNumber(first(pagination?.last_page, pagination?.lastPage, pagination?.pages)),
  };
};

const chapterIdFromItem = (item: JsonObject): string => {
  const explicit = asString(first(item.id, item.chapter_id, item.hid));
  if (explicit) {
    return explicit;
  }
  const url = asString(first(item.url, item.chapterUrl, item.chapter_url));
  return url ? (url.split("/").at(-1)?.split("-")[0] ?? url) : "";
};

const chapterNumberFromItem = (item: JsonObject): number =>
  asNumber(
    first(item.number, item.chapter, item.chapterNumber, item.chapter_number, item.chapter_num),
  ) ?? 0;

const chapterUrlFromItem = (item: JsonObject): string =>
  asString(first(item.url, item.chapterUrl, item.chapter_url));

export const toChapter = (item: JsonObject, sourceManga: SourceManga): Chapter => ({
  chapterId: chapterIdFromItem(item),
  sourceManga,
  langCode: asString(first(item.langCode, item.language, item.language_code), "en"),
  chapNum: chapterNumberFromItem(item),
  title: asString(first(item.title, item.name)) || undefined,
  volume: asNumber(first(item.volume, item.volumeNumber, item.volume_number)),
  publishDate: asDate(
    first(item.publishDate, item.publishedAt, item.published_at, item.createdAt, item.created_at),
  ),
  additionalInfo: {
    ...(chapterUrlFromItem(item) && { "Comix chapter URL": chapterUrlFromItem(item) }),
    ...(asString(first(item.scanlationGroup, item.scanlation_group)) && {
      "Scanlation group": asString(first(item.scanlationGroup, item.scanlation_group)),
    }),
  },
});

const pageFromItem = (value: JsonValue): ComixPage | undefined => {
  if (isString(value)) {
    return value ? { url: value } : undefined;
  }
  const item = asObject(value);
  if (!item) {
    return undefined;
  }
  const url = asString(first(item.url, item.src, item.image, item.path));
  return url ? { url, width: asNumber(item.width), height: asNumber(item.height) } : undefined;
};

export const pageItems = (payload: JsonValue): ComixPage[] => {
  const root = resultObject(payload);
  const pages = asObject(first(root.pages, root.images, root.data));
  const candidates = asArray(first(pages?.items, pages?.pages, root.items, root.images));
  const baseUrl = asString(first(pages?.baseUrl, pages?.base_url));

  return candidates
    .map(pageFromItem)
    .filter((page): page is ComixPage => page !== undefined)
    .map((page) => ({
      ...page,
      url: page.url.startsWith("http") ? page.url : `${baseUrl}${page.url}`,
    }));
};

export const toChapterDetails = (payload: JsonValue, chapter: Chapter): ChapterDetails => {
  const pages = pageItems(payload);
  if (pages.length === 0) {
    throw new Error(
      "Comix returned no readable pages; the chapter payload may still be signed or encrypted",
    );
  }

  return {
    id: chapter.chapterId,
    mangaId: chapter.sourceManga.mangaId,
    type: "images",
    pages: pages.map((page) => page.url),
  };
};
