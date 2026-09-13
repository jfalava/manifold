import { ANILIST_GRAPHQL_ENDPOINT } from "@manifold/canonical/sources";
import { isFiniteNumber, isString, manifoldUserAgent, type JsonObject } from "@manifold/json";
import { Effect } from "effect";
import {
  epochMillisNow,
  fromPromise,
  cliError,
  type CliEffectError,
  jsonFromResponseEffect,
  platformFetch,
  runHost,
  sleep,
} from "@/effect-kit";

const USER_AGENT = manifoldUserAgent("cli");

/** AniList degraded limit is ~30 req/min; 1200ms spacing stays under it. */
const REQUEST_INTERVAL_MS = 2_500; // 30/min ÷ 1.25 safety margin → ≤24 req/min

export interface AniListEntry {
  readonly mediaId: number;
  readonly title: string;
  readonly status: string;
  /** Integer chapter progress as reported by AniList. */
  readonly progress?: number;
  /** MAL cross-link from AniList media when present (digits only). */
  readonly malId?: string;
  /** English / romaji / synonyms for title matching on other providers. */
  readonly titles?: readonly string[];
}

interface MediaList {
  mediaId?: number;
  status?: string;
  progress?: number;
  media?: {
    idMal?: number | null;
    title?: { romaji?: string; english?: string };
    synonyms?: string[] | null;
  };
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
  "REPEATING",
]);

const VIEWER_QUERY = `query { Viewer { id } }`;

const MEDIA_LIST_QUERY = `query ($userId: Int) {
  MediaListCollection(type: MANGA, userId: $userId) {
    lists {
      entries {
        mediaId
        status
        progress
        media {
          idMal
          title { romaji english }
          synonyms
        }
      }
    }
  }
}`;

interface GraphQLResponse<A> {
  data?: A;
  errors?: { message?: string }[];
}

let lastRequestAt = 0;

const throttleEffect = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const wait = REQUEST_INTERVAL_MS - (epochMillisNow() - lastRequestAt);
    if (wait > 0) {
      yield* sleep(wait);
    }
    lastRequestAt = epochMillisNow();
  });

const gqlEffect = <A>(
  token: string,
  query: string,
  variables: JsonObject = {},
  attempt = 0,
): Effect.Effect<A, CliEffectError> =>
  Effect.gen(function* () {
    yield* throttleEffect();
    const response = yield* fromPromise(() =>
      platformFetch(ANILIST_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ query, variables }),
      }),
    ).pipe(Effect.mapError((cause) => cliError(`AniList fetch failed: ${cause.message}`)));
    if (response.status === 429 && attempt < 5) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "5");
      yield* sleep(Math.max(retryAfter, 5) * 1000);
      return yield* gqlEffect<A>(token, query, variables, attempt + 1);
    }
    const raw = yield* jsonFromResponseEffect(response, "anilist.gql");
    // SAFETY: HTTP value is the expected GraphQLResponse<A> after JSON parse
    const body = raw as GraphQLResponse<A>;
    if (body.errors?.length) {
      return yield* cliError(body.errors.map((e) => e.message ?? "?").join("; "));
    }
    if (!response.ok) {
      return yield* cliError(`AniList HTTP ${response.status}`);
    }
    // SAFETY: value matches A at this call site after error checks
    return body.data as A;
  });

const MEDIA_TITLES_QUERY = `query ($id: Int) {
  Media(id: $id, type: MANGA) {
    title { romaji english native }
    synonyms
  }
}`;

const fetchAniListTitlesEffect = (
  token: string,
  mediaId: number,
): Effect.Effect<readonly string[], CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* gqlEffect<{
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
    ].filter((title): title is string => isString(title) && title.trim().length > 0);
  });

export const fetchAniListTitles = (token: string, mediaId: number): Promise<readonly string[]> =>
  runHost(fetchAniListTitlesEffect(token, mediaId));

/** Resolves the token owner's AniList user id. */
const fetchAniListViewerIdEffect = (token: string): Effect.Effect<number, CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* gqlEffect<{ Viewer?: { id?: number } }>(token, VIEWER_QUERY);
    const id = data.Viewer?.id;
    if (!isFiniteNumber(id)) {
      return yield* cliError("AniList returned no Viewer id");
    }
    return id;
  });

export const fetchAniListViewerId = (token: string): Promise<number> =>
  runHost(fetchAniListViewerIdEffect(token));

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
const fetchAniListRichEntriesEffect = (
  token: string,
): Effect.Effect<readonly AniListRichEntry[], CliEffectError> =>
  Effect.gen(function* () {
    const userId = yield* fetchAniListViewerIdEffect(token);
    const data = yield* gqlEffect<ListCollection>(token, MEDIA_LIST_RICH_QUERY, { userId });
    const lists = data.MediaListCollection?.lists ?? [];
    const seen = new Set<number>();
    const entries: AniListRichEntry[] = [];
    for (const list of lists) {
      // SAFETY: optional field is { entries?: RichMediaList[] } when present at this call site
      for (const entry of (list as { entries?: RichMediaList[] }).entries ?? []) {
        if (!entry.mediaId || seen.has(entry.mediaId)) {
          continue;
        }
        const status = entry.status ?? "";
        if (!ANILIST_STATUSES.has(status)) {
          continue;
        }
        seen.add(entry.mediaId);
        const media = entry.media;
        const titles = [
          media?.title?.english,
          media?.title?.romaji,
          ...(media?.synonyms ?? []),
        ].filter((t): t is string => isString(t) && t.length > 0);
        const primary =
          media?.title?.english ?? media?.title?.romaji ?? `AniList #${entry.mediaId}`;
        entries.push({
          mediaId: entry.mediaId,
          status,
          title: primary,
          ...(media?.title?.romaji && { romajiTitle: media.title.romaji }),
          ...(media?.title?.native && { nativeTitle: media.title.native }),
          synonyms: [...new Set(titles)].filter((t) => t !== primary),
          ...(media?.description && { description: media.description }),
          ...((media?.coverImage?.extraLarge || media?.coverImage?.large) && {
            coverUrl: media.coverImage.extraLarge ?? media.coverImage.large,
          }),
          ...(media?.status && { mediaStatus: media.status }),
          ...(isFiniteNumber(media?.averageScore) && {
            averageScore: media.averageScore,
          }),
          ...(isFiniteNumber(entry.createdAt) &&
            entry.createdAt > 0 && { createdAt: entry.createdAt }),
        });
      }
    }
    return entries;
  });

export const fetchAniListRichEntries = (token: string): Promise<readonly AniListRichEntry[]> =>
  runHost(fetchAniListRichEntriesEffect(token));

/**
 * Fetches the authenticated user's manga list as flat entries with status and
 * integer progress. Entries with an unrecognized status are skipped.
 */
const fetchAniListMangaEntriesEffect = (
  token: string,
): Effect.Effect<readonly AniListEntry[], CliEffectError> =>
  Effect.gen(function* () {
    const userId = yield* fetchAniListViewerIdEffect(token);
    const data = yield* gqlEffect<ListCollection>(token, MEDIA_LIST_QUERY, { userId });
    const lists = data.MediaListCollection?.lists ?? [];
    const seen = new Set<number>();
    const entries: AniListEntry[] = [];
    for (const list of lists) {
      for (const entry of list.entries ?? []) {
        if (!entry.mediaId || seen.has(entry.mediaId)) {
          continue;
        }
        const status = entry.status ?? "";
        if (!ANILIST_STATUSES.has(status)) {
          continue;
        }
        seen.add(entry.mediaId);
        const title =
          entry.media?.title?.english ?? entry.media?.title?.romaji ?? `AniList #${entry.mediaId}`;
        const titleVariants = [
          entry.media?.title?.english,
          entry.media?.title?.romaji,
          ...(entry.media?.synonyms ?? []),
        ].filter((value): value is string => isString(value) && value.trim().length > 0);
        const malId =
          isFiniteNumber(entry.media?.idMal) && entry.media.idMal > 0
            ? String(Math.floor(entry.media.idMal))
            : undefined;
        entries.push({
          mediaId: entry.mediaId,
          title,
          status,
          ...(isFiniteNumber(entry.progress) &&
            entry.progress >= 1 && { progress: Math.floor(entry.progress) }),
          ...(malId && { malId }),
          ...(titleVariants.length > 0 && { titles: [...new Set(titleVariants)] }),
        });
      }
    }
    return entries;
  });

export const fetchAniListMangaEntries = (token: string): Promise<readonly AniListEntry[]> =>
  runHost(fetchAniListMangaEntriesEffect(token));
