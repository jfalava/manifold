import {
  arrayField,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  numberField,
  objectField,
  stringField,
  type JsonValue,
} from "@manifold/json";
import { Effect } from "effect";

import type { PhaseReporter } from "@/ui";
import {
  cliError,
  fromPromise,
  jsonFromResponseEffect,
  platformFetch,
  runHost,
  sleep,
  type CliEffectError,
} from "@/effect-kit";

const USER_AGENT = manifoldUserAgent("cli");

/**
 * AniList manga-list & activity wipe, ported from
 * github.com/criccadamus/anilist-manga-bulk-delete (bun/TS version).
 * Deletes ALL manga list entries and manga list activities.
 * TEXT activities are only targeted with the explicit
 * includeTextActivities opt-in; anime is never touched.
 */

const API_URL = "https://graphql.anilist.co";

// Bulk deletes hit AniList rate limits routinely: entries and activities share
// one 429-aware POST path with a bounded retry loop (no unbounded recursion).
const DELETE_429_MAX_RETRIES = 5;
const RETRY_AFTER_FALLBACK_MS = 60_000;

/**
 * Parses a retry-after response header (seconds) into milliseconds.
 * Missing or malformed values fall back to 60s instead of hot-looping.
 */
export const retryAfterMs = (response: Response): number => {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") {
    return RETRY_AFTER_FALLBACK_MS;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : RETRY_AFTER_FALLBACK_MS;
};

/** JSON scalar map for GraphQL request variables. */
export interface GraphQLVariables {
  readonly [key: string]: string | number | boolean | null | undefined;
}

const hasGraphQLErrors = (value: JsonValue): boolean => {
  if (!isJsonObject(value)) {
    return true;
  }
  const errors = value["errors"];
  return errors !== undefined && (!isJsonArray(errors) || errors.length > 0);
};

const decodeViewer = (value: JsonValue): { id: number; name: string } | undefined => {
  if (hasGraphQLErrors(value) || !isJsonObject(value)) {
    return undefined;
  }
  const data = objectField(value, "data");
  const viewer = data === undefined ? undefined : objectField(data, "Viewer");
  if (viewer === undefined) {
    return undefined;
  }
  const id = viewer["id"];
  const name = viewer["name"];
  return isFiniteNumber(id) && isString(name) ? { id, name } : undefined;
};

const decodeMangaEntries = (value: JsonValue): WipeListEntry[] | undefined => {
  if (hasGraphQLErrors(value) || !isJsonObject(value)) {
    return undefined;
  }
  const data = objectField(value, "data");
  const collection = data === undefined ? undefined : objectField(data, "MediaListCollection");
  if (collection === undefined) {
    return undefined;
  }
  const listsValue = collection["lists"];
  if (listsValue === null) {
    return [];
  }
  if (listsValue === undefined) {
    return undefined;
  }
  if (!isJsonArray(listsValue)) {
    return undefined;
  }

  const entries: WipeListEntry[] = [];
  for (const listValue of listsValue) {
    if (!isJsonObject(listValue)) {
      return undefined;
    }
    const entriesValue = listValue["entries"];
    if (entriesValue === undefined || entriesValue === null) {
      continue;
    }
    if (!isJsonArray(entriesValue)) {
      return undefined;
    }
    for (const entryValue of entriesValue) {
      if (!isJsonObject(entryValue) || !isFiniteNumber(entryValue["id"])) {
        return undefined;
      }
      const mediaValue = entryValue["media"];
      if (mediaValue !== undefined && mediaValue !== null && !isJsonObject(mediaValue)) {
        return undefined;
      }
      const media = isJsonObject(mediaValue) ? mediaValue : undefined;
      const mediaId = media !== undefined && isFiniteNumber(media["id"]) ? media["id"] : 0;
      const title = media === undefined ? undefined : objectField(media, "title");
      entries.push({
        id: entryValue["id"],
        mediaId,
        title:
          title === undefined
            ? "Unknown"
            : (stringField(title, "english") ?? stringField(title, "romaji") ?? "Unknown"),
      });
    }
  }
  return entries;
};

const postGraphQLEffect = (
  token: string,
  query: string,
  variables: GraphQLVariables,
): Effect.Effect<Response, CliEffectError> =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt += 1) {
      const response = yield* fromPromise(() =>
        platformFetch(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify({ query, variables }),
        }),
      ).pipe(Effect.mapError((cause) => cliError(`AniList wipe POST failed: ${cause.message}`)));
      if (response.status !== 429 || attempt >= DELETE_429_MAX_RETRIES) {
        return response;
      }
      yield* sleep(retryAfterMs(response));
    }
  });

export interface WipeListEntry {
  /** MediaListEntry id — the deletion target. */
  id: number;
  mediaId: number;
  title: string;
}

const fetchViewerEffect = (
  token: string,
): Effect.Effect<{ id: number; name: string }, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ query: `query { Viewer { id name } }` }),
      }),
    ).pipe(Effect.mapError((cause) => cliError(`Viewer query failed: ${cause.message}`)));
    if (!response.ok) {
      return yield* cliError(`Viewer query failed: HTTP ${response.status}`);
    }
    const raw = yield* jsonFromResponseEffect(response, "anilist.viewer");
    const viewer = decodeViewer(raw);
    if (viewer === undefined) {
      return yield* cliError("AniList returned an invalid Viewer response");
    }
    return viewer;
  });

export const fetchViewer = (token: string): Promise<{ id: number; name: string }> =>
  runHost(fetchViewerEffect(token));

const fetchMangaEntriesEffect = (
  token: string,
  userId: number,
): Effect.Effect<WipeListEntry[], CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          query: `query ($userId: Int) {
        MediaListCollection(userId: $userId, type: MANGA) {
          lists { entries { id media { id title { romaji english } } } }
        }
      }`,
          variables: { userId },
        }),
      }),
    ).pipe(Effect.mapError((cause) => cliError(`Manga list fetch failed: ${cause.message}`)));
    if (!response.ok) {
      return yield* cliError(`Manga list fetch failed: HTTP ${response.status}`);
    }
    const raw = yield* jsonFromResponseEffect(response, "anilist.manga-list");
    const decoded = decodeMangaEntries(raw);
    if (decoded === undefined) {
      return yield* cliError("AniList returned an invalid manga-list response");
    }
    const seen = new Set<number>();
    const entries: WipeListEntry[] = [];
    for (const entry of decoded) {
      if (seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries;
  });

export const fetchMangaEntries = (token: string, userId: number): Promise<WipeListEntry[]> =>
  runHost(fetchMangaEntriesEffect(token, userId));

/**
 * Decodes an AniList mutation envelope ({ data: { <field>: { deleted } } })
 * and returns the deleted flag, or undefined on GraphQL errors or a missing
 * flag. Callers treat anything but true as failure.
 */
const decodeDeletedEnvelopeEffect = (
  response: Response,
  field: string,
): Effect.Effect<boolean | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const payload = yield* jsonFromResponseEffect(response, "anilist.delete");
    if (!isJsonObject(payload)) {
      return undefined;
    }
    const errors = arrayField(payload, "errors");
    if (errors !== undefined && errors.length > 0) {
      return undefined;
    }
    const envelope = objectField(payload, "data");
    const mutation = envelope === undefined ? undefined : objectField(envelope, field);
    if (mutation === undefined) {
      return undefined;
    }
    const deleted = mutation["deleted"];
    return isBoolean(deleted) ? deleted : undefined;
  });

const deleteEntryEffect = (
  token: string,
  entryId: number,
): Effect.Effect<boolean, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* postGraphQLEffect(
      token,
      `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
      { id: entryId },
    );
    if (!response.ok) {
      return false;
    }
    const deleted = yield* decodeDeletedEnvelopeEffect(response, "DeleteMediaListEntry");
    return deleted === true;
  });

export const deleteEntry = (token: string, entryId: number): Promise<boolean> =>
  runHost(deleteEntryEffect(token, entryId));

// ---------- activities ----------

export type Activity =
  | {
      type: "MANGA_LIST";
      id: number;
      status?: string;
      progress?: string | null;
      mediaTitle?: string;
    }
  | { type: "TEXT"; id: number; text: string };

interface ActivitiesPage {
  hasNextPage: boolean;
  activities: Activity[];
}

const fetchActivitiesPageEffect = (
  token: string,
  userId: number,
  page: number,
): Effect.Effect<ActivitiesPage, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          query: `query ($userId: Int, $page: Int) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          activities(userId: $userId, type_in: [MANGA_LIST, TEXT]) {
            ... on ListActivity { id type status progress media { id type title { romaji english } } }
            ... on TextActivity { id type text createdAt }
          }
        }
      }`,
          variables: { userId, page },
        }),
      }),
    ).pipe(Effect.mapError((cause) => cliError(`Activity page fetch failed: ${cause.message}`)));
    if (!response.ok) {
      return yield* cliError(`Activity page fetch failed: HTTP ${response.status}`);
    }
    // SAFETY: AniList activity page JSON is decoded via isJsonObject / field helpers below
    const data: unknown = yield* jsonFromResponseEffect(response, "anilist.activities");
    const envelope = isJsonObject(data) ? objectField(data, "data") : undefined;
    const pageRecord = envelope === undefined ? undefined : objectField(envelope, "Page");
    const activityItems =
      pageRecord === undefined
        ? []
        : (arrayField(pageRecord, "activities") ?? []).filter(isJsonObject);
    const activities: Activity[] = [];
    for (const item of activityItems) {
      const id = numberField(item, "id");
      if (id === undefined) {
        continue;
      }
      const type = stringField(item, "type");
      if (type === "MANGA_LIST") {
        const media = objectField(item, "media");
        const title = media === undefined ? undefined : objectField(media, "title");
        activities.push({
          type: "MANGA_LIST",
          id,
          status: stringField(item, "status") ?? "",
          progress: stringField(item, "progress") ?? null,
          mediaTitle:
            title === undefined
              ? "Unknown"
              : (stringField(title, "english") ?? stringField(title, "romaji") ?? "Unknown"),
        });
      } else if (type === "TEXT") {
        activities.push({ type: "TEXT", id, text: stringField(item, "text") ?? "" });
      }
    }
    const pageInfo = pageRecord === undefined ? undefined : objectField(pageRecord, "pageInfo");
    return { activities, hasNextPage: pageInfo !== undefined && pageInfo.hasNextPage === true };
  });

export interface ActivitySelectionOptions {
  /**
   * Include TEXT activities (posts) in the deletion targets. Off by default:
   * post text cannot be reliably classified as manga-related, so deleting it
   * requires this explicit opt-in (preview first with a dry run).
   */
  includeTextActivities?: boolean;
}

/**
 * Deletion-target selection: typed MANGA_LIST activities always qualify.
 * TEXT activities qualify only when explicitly opted in — never by keyword
 * guessing, which pulled in unrelated prose such as "already watched anime".
 */
export const selectWipeActivities = (
  activities: readonly Activity[],
  options: ActivitySelectionOptions = {},
): Activity[] => {
  const includeTextActivities = options.includeTextActivities === true;
  return activities.filter((activity) => {
    if (activity.type === "MANGA_LIST") {
      return true;
    }
    if (activity.type === "TEXT") {
      return includeTextActivities;
    }
    return false;
  });
};

const fetchMangaActivitiesEffect = (
  token: string,
  userId: number,
  report?: PhaseReporter,
  options: ActivitySelectionOptions = {},
): Effect.Effect<Activity[], CliEffectError> =>
  Effect.gen(function* () {
    const includeTextActivities = options.includeTextActivities === true;
    const all: Activity[] = [];
    let page = 1;
    let hasNextPage = true;
    while (hasNextPage) {
      const result = yield* fetchActivitiesPageEffect(token, userId, page);
      for (const activity of selectWipeActivities(result.activities, options)) {
        all.push(activity);
      }
      report?.detail(
        `page ${page}: ${result.activities.length} activities (${all.length} ${
          includeTextActivities ? "selected, text included" : "manga list"
        } so far)`,
      );
      hasNextPage = result.hasNextPage;
      page += 1;
      yield* sleep(3000);
    }
    return all;
  });

export const fetchMangaActivities = (
  token: string,
  userId: number,
  report?: PhaseReporter,
  options: ActivitySelectionOptions = {},
): Promise<Activity[]> => runHost(fetchMangaActivitiesEffect(token, userId, report, options));

const deleteActivityEffect = (
  token: string,
  activityId: number,
): Effect.Effect<{ success: boolean; alreadyDeleted: boolean }, CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* postGraphQLEffect(
      token,
      `mutation ($id: Int) { DeleteActivity(id: $id) { deleted } }`,
      { id: activityId },
    );
    if (!response.ok) {
      if (response.status === 400) {
        const body = yield* fromPromise(() => response.text()).pipe(
          Effect.mapError((cause) => cliError(cause.message)),
        );
        if (body.includes("The selected id is invalid")) {
          return { success: true, alreadyDeleted: true };
        }
      }
      return { success: false, alreadyDeleted: false };
    }
    const deleted = yield* decodeDeletedEnvelopeEffect(response, "DeleteActivity");
    if (deleted !== true) {
      return { success: false, alreadyDeleted: false };
    }
    return { success: true, alreadyDeleted: false };
  });

export const deleteActivity = (
  token: string,
  activityId: number,
): Promise<{ success: boolean; alreadyDeleted: boolean }> =>
  runHost(deleteActivityEffect(token, activityId));

const deleteEntriesWithProgressEffect = (
  token: string,
  entries: readonly WipeListEntry[],
  report?: PhaseReporter,
): Effect.Effect<{ ok: number; failed: number }, never> =>
  Effect.gen(function* () {
    let ok = 0;
    let failed = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      const outcome = yield* deleteEntryEffect(token, entry.id).pipe(
        Effect.map((deleted) => (deleted ? ("ok" as const) : ("fail" as const))),
        Effect.orElseSucceed(() => "fail" as const),
      );
      if (outcome === "ok") {
        ok += 1;
      } else {
        failed += 1;
      }
      report?.progress(index + 1, entries.length, [
        ["ok", ok],
        ["fail", failed],
      ]);
      yield* sleep(2500);
    }
    return { ok, failed };
  });

export const deleteEntriesWithProgress = (
  token: string,
  entries: readonly WipeListEntry[],
  report?: PhaseReporter,
): Promise<{ ok: number; failed: number }> =>
  runHost(deleteEntriesWithProgressEffect(token, entries, report));

const deleteActivitiesWithProgressEffect = (
  token: string,
  activities: readonly Activity[],
  report?: PhaseReporter,
): Effect.Effect<{ ok: number; failed: number; skipped: number }, never> =>
  Effect.gen(function* () {
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    for (let index = 0; index < activities.length; index += 1) {
      const activity = activities[index];
      if (!activity) {
        continue;
      }
      const result = yield* deleteActivityEffect(token, activity.id).pipe(
        Effect.orElseSucceed(() => ({ success: false, alreadyDeleted: false })),
      );
      if (result.alreadyDeleted) {
        skipped += 1;
      } else if (result.success) {
        ok += 1;
      } else {
        failed += 1;
      }
      report?.progress(index + 1, activities.length, [
        ["ok", ok],
        ["fail", failed],
        ["skip", skipped],
      ]);
      yield* sleep(3000);
    }
    return { ok, failed, skipped };
  });

export const deleteActivitiesWithProgress = (
  token: string,
  activities: readonly Activity[],
  report?: PhaseReporter,
): Promise<{ ok: number; failed: number; skipped: number }> =>
  runHost(deleteActivitiesWithProgressEffect(token, activities, report));
