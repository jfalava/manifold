import {
  CloudflareError,
  ContentRating,
  DiscoverSectionType,
  type DiscoverSection,
  type DiscoverSectionItem,
  type Metadata,
  type PagedResults,
} from "@paperback/types";
import {
  MANGADEX_CONTENT_RATINGS,
  type MangaDexChapter,
  type MangaDexChapterFeedOptions,
  type MangaDexManga,
  type MangaDexMangaListOptions,
} from "@manifold/mangadex";

const PAGE_LIMIT = 20;
const POPULAR_NEW_TITLES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// MangaDex validates createdAtSince against ^\d{4}-[0-1]\d-...T...:[0-5]\d:[0-5]\d$ —
// no fractional seconds and no timezone suffix. Inkdex anchors the window to
// start-of-day UTC so the 30-day Popular slice matches the website.
const mangaDexTimestamp = (date: Date): string => {
  const anchored = new Date(date);
  anchored.setUTCHours(0, 0, 0, 0);
  return anchored.toISOString().slice(0, 19);
};

export interface ManifoldLibraryEntry {
  // Registry UUID — the Paperback-facing manga id.
  readonly id: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly coverUrl?: string;
  // Upstream AniList media id, for provider-scoped lookups.
  readonly anilistId?: string;
}

// One winning card per library title, whichever source supplied it.
export interface UpdateCard {
  readonly source: "MD" | "Comix";
  readonly mangaId: string;
  readonly chapterId: string;
  readonly subtitle: string;
  readonly publishDate?: Date;
}

export interface ManifoldDiscoverContext {
  readonly listManga: (
    options: MangaDexMangaListOptions,
  ) => Promise<{ readonly items: readonly MangaDexManga[]; readonly total?: number }>;
  readonly latestChapters: (
    options: MangaDexChapterFeedOptions,
  ) => Promise<{ readonly items: readonly MangaDexChapter[]; readonly total?: number }>;
  readonly getAnilistLibrary?: () => Promise<readonly ManifoldLibraryEntry[]>;
  // MangaDex board surfaces a wider AniList slice (reading + planning +
  // on_hold/PAUSED) while Comix keeps the prompt limited to reading titles
  // so its expensive WebView capture stays bounded.
  readonly getAnilistLibraryForMangadex?: () => Promise<readonly ManifoldLibraryEntry[]>;
  // Parity resolvers: freshest chapter for one library title on each source.
  // Both are cached upstream and fail soft (undefined).
  readonly mangadexLatest?: (
    entry: ManifoldLibraryEntry,
  ) => Promise<UpdateCard | undefined>;
  readonly comixLatest?: (
    entry: ManifoldLibraryEntry,
  ) => Promise<UpdateCard | undefined>;
}

export const DISCOVER_SECTIONS = [
  { id: "popular-new-titles", title: "Popular New Titles", type: DiscoverSectionType.prominentCarousel },
  { id: "latest-updates", title: "Latest Updates", type: DiscoverSectionType.chapterUpdates },
  { id: "my-updates-mangadex", title: "My Updates · MangaDex", type: DiscoverSectionType.chapterUpdates },
  { id: "my-updates-comix", title: "My Updates · Comix", type: DiscoverSectionType.chapterUpdates },
] as const;

const offsetFromMetadata = (metadata: Metadata | undefined): number => {
  const record =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? (metadata as { readonly offset?: unknown })
      : undefined;
  const value = record?.offset;
  return typeof value === "number" ? value : 0;
};

const nextOffsetMetadata = (
  offset: number,
  count: number,
  total: number | undefined,
): Metadata | undefined =>
  count > 0 && (total === undefined || offset + count < total) ? { offset: offset + count } : undefined;

const orderedUniqueMangaIds = (chapters: readonly MangaDexChapter[]): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const chapter of chapters) {
    if (seen.has(chapter.mangaId)) {continue;}
    seen.add(chapter.mangaId);
    ids.push(chapter.mangaId);
  }
  return ids;
};

const reorderById = <T extends { readonly id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] => {
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
};

const toMangaItems = (
  manga: readonly MangaDexManga[],
): DiscoverSectionItem[] =>
  manga.map((entry) => ({
    type: "prominentCarouselItem",
    mangaId: `mangadex:${entry.id}`,
    imageUrl: entry.coverUrl ?? "",
    title: entry.title,
    contentRating: ContentRating.MATURE,
  }));

const chapterSubtitle = (chapter: MangaDexChapter): string => {
  const volume = chapter.volumeNumber === undefined ? "" : `Vol. ${chapter.volumeNumber} `;
  const number = chapter.chapterNumber === undefined ? "" : `Ch. ${chapter.chapterNumber}`;
  const label = `${volume}${number}`.trim();
  return chapter.title ? `${label} · ${chapter.title}` : label;
};

const toChapterUpdateItems = (
  chapters: readonly MangaDexChapter[],
  mangaById: ReadonlyMap<string, MangaDexManga>,
): DiscoverSectionItem[] =>
  chapters.flatMap((chapter) => {
    const manga = mangaById.get(chapter.mangaId);
    if (!manga) {return [];}
    return [{
      type: "chapterUpdatesCarouselItem",
      mangaId: `mangadex:${chapter.mangaId}`,
      chapterId: chapter.id,
      imageUrl: manga.coverUrl ?? "",
      title: manga.title,
      subtitle: chapterSubtitle(chapter),
      ...(chapter.publishedAt === undefined ? {} : { publishDate: new Date(chapter.publishedAt) }),
      contentRating: ContentRating.MATURE,
    }];
  });

const carouselPage = async (
  context: ManifoldDiscoverContext,
  metadata: Metadata | undefined,
  options: MangaDexMangaListOptions,
): Promise<PagedResults<DiscoverSectionItem>> => {
  const offset = offsetFromMetadata(metadata);
  // Popular must surface adult titles too — MangaDex defaults to safe+suggestive
  // and would otherwise hide erotica/pornographic entries. Mirror inkdex's
  // getRatings() by explicitly requesting every content rating; force it after
  // the spread so callers cannot accidentally narrow it.
  const page = await context.listManga({
    ...options,
    contentRating: [...MANGADEX_CONTENT_RATINGS],
    limit: PAGE_LIMIT,
    offset,
  });
  return {
    items: toMangaItems(page.items),
    metadata: nextOffsetMetadata(offset, page.items.length, page.total),
  };
};

const chapterUpdatesPage = async (
  context: ManifoldDiscoverContext,
  metadata: Metadata | undefined,
  feed: (options: MangaDexChapterFeedOptions) => Promise<{
    readonly items: readonly MangaDexChapter[];
    readonly total?: number;
  }>,
): Promise<PagedResults<DiscoverSectionItem>> => {
  const offset = offsetFromMetadata(metadata);
  const page = await feed({ limit: PAGE_LIMIT, offset });

  const mangaIds = orderedUniqueMangaIds(page.items);
  if (mangaIds.length === 0) {
    return { items: [], metadata: nextOffsetMetadata(offset, page.items.length, page.total) };
  }

  const details = await context.listManga({
    ids: mangaIds,
    limit: mangaIds.length,
    contentRating: [...MANGADEX_CONTENT_RATINGS],
  });
  const mangaById = new Map(
    reorderById(details.items, mangaIds).map((manga) => [manga.id, manga]),
  );

  return {
    items: toChapterUpdateItems(page.items, mangaById),
    metadata: nextOffsetMetadata(offset, page.items.length, page.total),
  };
};

const chapterUpdateItem = (
  entry: ManifoldLibraryEntry,
  card: UpdateCard,
): DiscoverSectionItem => ({
  type: "chapterUpdatesCarouselItem",
  mangaId: card.mangaId,
  chapterId: card.chapterId,
  imageUrl: entry.coverUrl ?? "",
  title: entry.title,
  subtitle: card.subtitle,
  ...(card.publishDate === undefined ? {} : { publishDate: card.publishDate }),
  contentRating: ContentRating.MATURE,
});

// Parity: both update sections walk an AniList library slice and ask
// their source for each title's freshest chapter. MangaDex walks the wider
// reading+planning+on_hold slice; Comix walks reading only so its WebView
// capture stays bounded. Identical pagination and card shape; only the library
// getter and resolver differ. Duplicates across the two sections are accepted
// by design.
const libraryUpdatesPage = async (
  context: ManifoldDiscoverContext,
  metadata: Metadata | undefined,
  getLibrary: () => Promise<readonly ManifoldLibraryEntry[] | undefined>,
  resolve: (entry: ManifoldLibraryEntry) => Promise<UpdateCard | undefined>,
  options?: { sortGlobally?: boolean; softCloudflare?: boolean },
): Promise<PagedResults<DiscoverSectionItem>> => {
  const offset = offsetFromMetadata(metadata);
  const library = await getLibrary();
  if (!library || library.length === 0) {return { items: [], metadata: undefined };}

  const resolveCard = async (entry: ManifoldLibraryEntry): Promise<UpdateCard | undefined> => {
    try {
      return await resolve(entry);
    } catch (error) {
      // Discover often logs CloudflareError without a bypass banner
      // (additionalInfo: n/a). Soft-fail keeps the section alive and leaves
      // Settings `force`/`adopt` as the controlled recovery path.
      if (error instanceof CloudflareError) {
        if (options?.softCloudflare) {
          console.error(
            `[manifold] updates CF soft-fail:${entry.title}:${error.message}`,
          );
          return undefined;
        }
        throw error;
      }
      return undefined;
    }
  };

  if (options?.sortGlobally) {
    // Global recency sort: resolve cards, sort by publishDate, then paginate.
    // This is why Boruto surfaces even when AniList list order puts it on a
    // later page. The MangaDex resolver applies a per-open fresh-probe budget
    // and serves stale cache past TTL so Discover is not empty for minutes
    // while hundreds of feed requests drain at ~4 req/s. Comix stays
    // paginated because each probe is a WebView capture.
    const cards = await Promise.all(library.map(resolveCard));
    const allItems: DiscoverSectionItem[] = [];
    for (let index = 0; index < library.length; index += 1) {
      const entry = library[index];
      const card = cards[index];
      if (!entry || !card) {continue;}
      allItems.push(chapterUpdateItem(entry, card));
    }
    allItems.sort((a, b) => {
      const aTime = (a as { publishDate?: Date }).publishDate?.getTime() ?? 0;
      const bTime = (b as { publishDate?: Date }).publishDate?.getTime() ?? 0;
      return bTime - aTime;
    });
    const pageItems = allItems.slice(offset, offset + PAGE_LIMIT);
    return {
      items: pageItems,
      metadata: nextOffsetMetadata(offset, pageItems.length, allItems.length),
    };
  }

  const pageEntries = library.slice(offset, offset + PAGE_LIMIT);

  const cards = await Promise.all(pageEntries.map(resolveCard));

  const items: DiscoverSectionItem[] = [];
  for (let index = 0; index < pageEntries.length; index += 1) {
    const entry = pageEntries[index];
    const card = cards[index];
    if (!entry || !card) {continue;}
    items.push(chapterUpdateItem(entry, card));
  }
  // Comix stays paginated (WebView cost), but still sort the visible page by
  // publishDate so the window feels recency-ordered.
  items.sort((a, b) => {
    const aTime = (a as { publishDate?: Date }).publishDate?.getTime() ?? 0;
    const bTime = (b as { publishDate?: Date }).publishDate?.getTime() ?? 0;
    return bTime - aTime;
  });
  return {
    items,
    metadata: nextOffsetMetadata(offset, pageEntries.length, library.length),
  };
};

export const getDiscoverSections = (): Promise<DiscoverSection[]> =>
  Promise.resolve(DISCOVER_SECTIONS.map(({ id, title, type }) => ({ id, title, type })));

export const getDiscoverSectionItems = async (
  section: DiscoverSection,
  metadata: Metadata | undefined,
  context: ManifoldDiscoverContext,
): Promise<PagedResults<DiscoverSectionItem>> => {
  if (section.id === "popular-new-titles") {
    return carouselPage(context, metadata, {
      orderKey: "followedCount",
      hasAvailableChapters: true,
      createdAtSince: mangaDexTimestamp(new Date(Date.now() - POPULAR_NEW_TITLES_WINDOW_MS)),
    });
  }

  if (section.id === "latest-updates") {
    return chapterUpdatesPage(context, metadata, (options) => context.latestChapters(options));
  }

  if (section.id === "my-updates-mangadex") {
    return libraryUpdatesPage(
      context,
      metadata,
      () =>
        (context.getAnilistLibraryForMangadex?.() ??
          context.getAnilistLibrary?.() ??
          Promise.resolve(undefined)) as Promise<readonly ManifoldLibraryEntry[] | undefined>,
      (entry) =>
        context.mangadexLatest ? context.mangadexLatest(entry) : Promise.resolve(undefined),
      { sortGlobally: true },
    );
  }

  if (section.id === "my-updates-comix") {
    const page = await libraryUpdatesPage(
      context,
      metadata,
      () =>
        (context.getAnilistLibrary?.() ??
          Promise.resolve(undefined)) as Promise<readonly ManifoldLibraryEntry[] | undefined>,
      (entry) =>
        context.comixLatest ? context.comixLatest(entry) : Promise.resolve(undefined),
      { softCloudflare: true },
    );
    console.log(
      `[manifold] comix updates page:${page.items.length} cards (offset=${offsetFromMetadata(metadata)})`,
    );
    return page;
  }

  return { items: [], metadata: undefined };
};
