import { ANILIST_GRAPHQL_ENDPOINT } from "@manifold/canonical/sources";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** AniList degraded limit is ~30 req/min; 1200ms spacing stays under it. */
const REQUEST_INTERVAL_MS = 2_500; // 30/min ÷ 1.25 safety margin → ≤24 req/min

export interface AniListEntry {
  readonly mediaId: number;
  readonly title: string;
  readonly status: string;
  /** Integer chapter progress as reported by AniList. */
  readonly progress?: number;
}

interface MediaList {
  mediaId?: number;
  status?: string;
  progress?: number;
  media?: { title?: { romaji?: string; english?: string } };
}

interface ListCollection {
  MediaListCollection?: {
    lists?: Array<{ entries?: MediaList[] }>;
  };
}

const ANILIST_STATUSES = new Set([
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "DROPPED",
  "PAUSED",
  "REPEATING"
]);

const VIEWER_QUERY = `query { Viewer { id } }`;

const MEDIA_LIST_QUERY = `query ($userId: Int) {
  MediaListCollection(type: MANGA, userId: $userId) {
    lists {
      entries {
        mediaId
        status
        progress
        media { title { romaji english } }
      }
    }
  }
}`;

interface GraphQLResponse<A> {
  data?: A;
  errors?: { message?: string }[];
}

let lastRequestAt = 0;

const throttle = async (): Promise<void> => {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) {await sleep(wait);}
  lastRequestAt = Date.now();
};

const gql = async <A>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 0,
): Promise<A> => {
  await throttle();
  const response = await fetch(ANILIST_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });
  if (response.status === 429 && attempt < 5) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "5");
    await sleep(Math.max(retryAfter, 5) * 1000);
    return gql<A>(token, query, variables, attempt + 1);
  }
  // SAFETY: HTTP value is the expected GraphQLResponse<A>; i after the preceding check
  const body = (await response.json()) as GraphQLResponse<A>;
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? "?").join("; "));
  }
  if (!response.ok) {throw new Error(`AniList HTTP ${response.status}`);}
  // SAFETY: value matches A; }; at this call site
  return body.data as A;
};

const MEDIA_TITLES_QUERY = `query ($id: Int) {
  Media(id: $id, type: MANGA) {
    title { romaji english native }
    synonyms
  }
}`;

export const fetchAniListTitles = async (
  token: string,
  mediaId: number,
): Promise<readonly string[]> => {
  const data = await gql<{
    Media?: {
      title?: { romaji?: string | null; english?: string | null; native?: string | null };
      synonyms?: readonly string[] | null;
    };
  }>(token, MEDIA_TITLES_QUERY, { id: mediaId });
  const media = data.Media;
  return [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(media?.synonyms ?? []),
  ].filter((title): title is string => typeof title === "string" && title.trim().length > 0);
};

/** Resolves the token owner's AniList user id. */
export const fetchAniListViewerId = async (token: string): Promise<number> => {
  const data = await gql<{ Viewer?: { id?: number } }>(token, VIEWER_QUERY);
  const id = data.Viewer?.id;
  if (typeof id !== "number") {throw new Error("AniList returned no Viewer id");}
  return id;
};

/** AniList list entry enriched for Paperback backup metadata generation. */
export interface AniListRichEntry {
  readonly mediaId: number;
  /** List status (CURRENT, PLANNING, …). */
  readonly status: string;
  readonly title: string;
  readonly romajiTitle?: string;
  readonly nativeTitle?: string;
  readonly synonyms: readonly string[];
  readonly description?: string;
  readonly coverUrl?: string;
  readonly mediaStatus?: string;
  readonly averageScore?: number;
  /** Unix seconds when the list entry was created (bookmarked date). */
  readonly createdAt?: number;
}

interface RichMediaList {
  mediaId?: number;
  status?: string;
  progress?: number;
  createdAt?: number;
  media?: {
    title?: { romaji?: string; english?: string; native?: string };
    synonyms?: string[];
    description?: string;
    coverImage?: { extraLarge?: string; large?: string };
    status?: string;
    averageScore?: number;
  };
}

const MEDIA_LIST_RICH_QUERY = `query ($userId: Int) {
  MediaListCollection(type: MANGA, userId: $userId) {
    lists {
      entries {
        mediaId
        status
        progress
        createdAt
        media {
          title { romaji english native }
          synonyms
          description(asHtml: false)
          coverImage { extraLarge large }
          status
          averageScore
        }
      }
    }
  }
}`;

/**
 * Fetches the authenticated user's manga list with full metadata needed to
 * render `__MANGA_INFO_V5` entities. Entries are deduped by mediaId; unknown
 * list statuses are skipped.
 */
export const fetchAniListRichEntries = async (
  token: string,
): Promise<readonly AniListRichEntry[]> => {
  const userId = await fetchAniListViewerId(token);
  const data = await gql<ListCollection>(token, MEDIA_LIST_RICH_QUERY, { userId });
  const lists = data.MediaListCollection?.lists ?? [];
  const seen = new Set<number>();
  const entries: AniListRichEntry[] = [];
  for (const list of lists) {
    // SAFETY: optional field is { entries?: RichMediaList[] }).entri when present at this call site
    for (const entry of (list as { entries?: RichMediaList[] }).entries ?? []) {
      if (!entry.mediaId || seen.has(entry.mediaId)) {continue;}
      const status = entry.status ?? "";
      if (!ANILIST_STATUSES.has(status)) {continue;}
      seen.add(entry.mediaId);
      const media = entry.media;
      const titles = [
        media?.title?.english,
        media?.title?.romaji,
        ...(media?.synonyms ?? []),
      ].filter((t): t is string => typeof t === "string" && t.length > 0);
      const primary =
        media?.title?.english ??
        media?.title?.romaji ??
        `AniList #${entry.mediaId}`;
      entries.push({
        mediaId: entry.mediaId,
        status,
        title: primary,
        ...(media?.title?.romaji ? { romajiTitle: media.title.romaji } : {}),
        ...(media?.title?.native ? { nativeTitle: media.title.native } : {}),
        synonyms: [...new Set(titles)].filter((t) => t !== primary),
        ...(media?.description ? { description: media.description } : {}),
        ...(media?.coverImage?.extraLarge || media?.coverImage?.large
          ? {
              coverUrl:
                media.coverImage.extraLarge ?? media.coverImage.large,
            }
          : {}),
        ...(media?.status ? { mediaStatus: media.status } : {}),
        ...(typeof media?.averageScore === "number"
          ? { averageScore: media.averageScore }
          : {}),
        ...(typeof entry.createdAt === "number" && entry.createdAt > 0
          ? { createdAt: entry.createdAt }
          : {})
      });
    }
  }
  return entries;
};

/**
 * Fetches the authenticated user's manga list as flat entries with status and
 * integer progress. Entries with an unrecognized status are skipped.
 */
export const fetchAniListMangaEntries = async (
  token: string
): Promise<readonly AniListEntry[]> => {
  const userId = await fetchAniListViewerId(token);
  const data = await gql<ListCollection>(token, MEDIA_LIST_QUERY, { userId });
  const lists = data.MediaListCollection?.lists ?? [];
  const seen = new Set<number>();
  const entries: AniListEntry[] = [];
  for (const list of lists) {
    for (const entry of list.entries ?? []) {
      if (!entry.mediaId || seen.has(entry.mediaId)) {continue;}
      const status = entry.status ?? "";
      if (!ANILIST_STATUSES.has(status)) {continue;}
      seen.add(entry.mediaId);
      const title =
        entry.media?.title?.english ??
        entry.media?.title?.romaji ??
        `AniList #${entry.mediaId}`;
      entries.push({
        mediaId: entry.mediaId,
        title,
        status,
        ...(typeof entry.progress === "number" && entry.progress >= 1
          ? { progress: Math.floor(entry.progress) }
          : {})
      });
    }
  }
  return entries;
};
