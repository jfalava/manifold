import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  objectField,
  stringField,
  type JsonObject,
} from "@manifold/json";
import { Effect } from "effect";
import {
  cliError,
  type CliEffectError,
  runHost,
} from "@/effect-kit";
import { aniListGraphqlEffect } from "@/anilist-request";

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

const MEDIA_TITLES_QUERY = `query ($id: Int) {
  Media(id: $id, type: MANGA) {
    title { romaji english native }
    synonyms
  }
}`;

const fetchAniListTitlesEffect = (
  token: string,
  mediaId: number,
  signal?: AbortSignal,
): Effect.Effect<readonly string[], CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* aniListGraphqlEffect(
      "cli",
      token,
      MEDIA_TITLES_QUERY,
      { id: mediaId },
      signal,
    );

    const media = objectField(data, "Media");
    const title = media ? objectField(media, "title") : undefined;
    const synonyms = media?.synonyms;

    return [
      title && stringField(title, "english"),
      title && stringField(title, "romaji"),
      title && stringField(title, "native"),
      ...(isJsonArray(synonyms) ? synonyms.filter(isString) : []),
    ].filter((value): value is string => isString(value) && value.trim().length > 0);
  });

export const fetchAniListTitles = (
  token: string,
  mediaId: number,
  signal?: AbortSignal,
): Promise<readonly string[]> =>
  Effect.runPromise(fetchAniListTitlesEffect(token, mediaId, signal), { signal });

/** Resolves the token owner's AniList user id. */
const fetchAniListViewerIdEffect = (token: string): Effect.Effect<number, CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* aniListGraphqlEffect("cli", token, VIEWER_QUERY);
    const viewer = objectField(data, "Viewer");
    const id = viewer?.id;

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
    const data = yield* aniListGraphqlEffect("cli", token, MEDIA_LIST_RICH_QUERY, { userId });
    const rawEntries = listEntries(data);

    if (!rawEntries) {
      return yield* cliError("AniList returned an invalid manga list envelope");
    }

    const seen = new Set<number>();
    const entries: AniListRichEntry[] = [];

    for (const entry of rawEntries) {
      const mediaId = entry.mediaId;

      if (!isFiniteNumber(mediaId) || mediaId <= 0 || seen.has(mediaId)) {
        continue;
      }

      const status = stringField(entry, "status");

      if (!status || !ANILIST_STATUSES.has(status)) {
        continue;
      }

      seen.add(mediaId);
      const media = objectField(entry, "media");
      const titleObject = media ? objectField(media, "title") : undefined;
      const english = titleObject ? stringField(titleObject, "english") : undefined;
      const romaji = titleObject ? stringField(titleObject, "romaji") : undefined;
      const native = titleObject ? stringField(titleObject, "native") : undefined;
      const synonyms = media?.synonyms;

      const titles = [
        english,
        romaji,
        ...(isJsonArray(synonyms) ? synonyms.filter(isString) : []),
      ].filter((t): t is string => isString(t) && t.length > 0);

      const primary = english ?? romaji ?? `AniList #${mediaId}`;
      const coverImage = media ? objectField(media, "coverImage") : undefined;
      const extraLarge = coverImage ? stringField(coverImage, "extraLarge") : undefined;
      const large = coverImage ? stringField(coverImage, "large") : undefined;
      const description = media ? stringField(media, "description") : undefined;
      const mediaStatus = media ? stringField(media, "status") : undefined;
      const averageScore = media?.averageScore;
      const createdAt = entry.createdAt;
      entries.push({
        mediaId,
        status,
        title: primary,
        ...(romaji && { romajiTitle: romaji }),
        ...(native && { nativeTitle: native }),
        synonyms: [...new Set(titles)].filter((t) => t !== primary),
        ...(description && { description }),
        ...((extraLarge || large) && { coverUrl: extraLarge ?? large }),
        ...(mediaStatus && { mediaStatus }),
        ...(isFiniteNumber(averageScore) && { averageScore }),
        ...(isFiniteNumber(createdAt) && createdAt > 0 && { createdAt }),
      });
    }

    return entries;
  });

export const fetchAniListRichEntries = (token: string): Promise<readonly AniListRichEntry[]> =>
  runHost(fetchAniListRichEntriesEffect(token));

const listEntries = (data: JsonObject): readonly JsonObject[] | undefined => {
  const collection = data.MediaListCollection;

  if (collection === null) {
    return [];
  }

  if (!isJsonObject(collection)) {
    return undefined;
  }

  const lists = collection.lists;

  if (lists === null) {
    return [];
  }

  if (!isJsonArray(lists)) {
    return undefined;
  }

  const entries: JsonObject[] = [];

  for (const list of lists) {
    if (!isJsonObject(list)) {
      return undefined;
    }

    const entryValues = list.entries;

    if (entryValues === undefined || entryValues === null) {
      continue;
    }

    if (!isJsonArray(entryValues)) {
      return undefined;
    }

    for (const entry of entryValues) {
      if (!isJsonObject(entry)) {
        return undefined;
      }

      entries.push(entry);
    }
  }

  return entries;
};

/**
 * Fetches the authenticated user's manga list as flat entries with status and
 * integer progress. Entries with an unrecognized status are skipped.
 */
const fetchAniListMangaEntriesEffect = (
  token: string,
): Effect.Effect<readonly AniListEntry[], CliEffectError> =>
  Effect.gen(function* () {
    const userId = yield* fetchAniListViewerIdEffect(token);
    const data = yield* aniListGraphqlEffect("cli", token, MEDIA_LIST_QUERY, { userId });
    const rawEntries = listEntries(data);

    if (!rawEntries) {
      return yield* cliError("AniList returned an invalid manga list envelope");
    }

    const seen = new Set<number>();
    const entries: AniListEntry[] = [];

    for (const entry of rawEntries) {
      const mediaId = entry.mediaId;

      if (!isFiniteNumber(mediaId) || mediaId <= 0 || seen.has(mediaId)) {
        continue;
      }

      const status = stringField(entry, "status");

      if (!status || !ANILIST_STATUSES.has(status)) {
        continue;
      }

      seen.add(mediaId);
      const media = objectField(entry, "media");
      const titleObject = media ? objectField(media, "title") : undefined;
      const english = titleObject ? stringField(titleObject, "english") : undefined;
      const romaji = titleObject ? stringField(titleObject, "romaji") : undefined;
      const title = english ?? romaji ?? `AniList #${mediaId}`;
      const synonyms = media?.synonyms;

      const titleVariants = [
        english,
        romaji,
        ...(isJsonArray(synonyms) ? synonyms.filter(isString) : []),
      ].filter((value): value is string => isString(value) && value.trim().length > 0);

      const malIdValue = media?.idMal;

      const malId =
        isFiniteNumber(malIdValue) && malIdValue > 0 ? String(Math.floor(malIdValue)) : undefined;

      const progress = entry.progress;
      entries.push({
        mediaId,
        title,
        status,
        ...(isFiniteNumber(progress) && progress >= 1 && { progress: Math.floor(progress) }),
        ...(malId && { malId }),
        ...(titleVariants.length > 0 && { titles: [...new Set(titleVariants)] }),
      });
    }

    return entries;
  });

export const fetchAniListMangaEntries = (token: string): Promise<readonly AniListEntry[]> =>
  runHost(fetchAniListMangaEntriesEffect(token));
