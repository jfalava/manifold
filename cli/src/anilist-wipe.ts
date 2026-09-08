import {
  arrayField,
  isJsonObject,
  manifoldUserAgent,
  numberField,
  objectField,
  stringField,
} from "@manifold/json";

import type { PhaseReporter } from "@/ui";

const USER_AGENT = manifoldUserAgent("cli");

/**
 * AniList manga-list & activity wipe, ported from
 * github.com/criccadamus/anilist-manga-bulk-delete (bun/TS version).
 * Deletes ALL manga list entries and ALL manga-related activities.
 * Anime is never touched.
 */

const API_URL = "https://graphql.anilist.co";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface WipeListEntry {
  /** MediaListEntry id — the deletion target. */
  id: number;
  mediaId: number;
  title: string;
}

export const fetchViewer = async (
  token: string
): Promise<{ id: number; name: string }> => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "user-agent": USER_AGENT
    },
    body: JSON.stringify({ query: `query { Viewer { id name } }` })
  });
  if (!response.ok) {throw new Error(`Viewer query failed: HTTP ${response.status}`);}
  // SAFETY: test/double or boundary cast through unknown to { data?: { Viewer?: { id: number; name: string } }; errors?: unknown[]; };
  const data = (await response.json()) as {
    data?: { Viewer?: { id: number; name: string } };
    errors?: unknown[];
  };
  if (!data.data?.Viewer) {throw new Error("AniList returned no Viewer");}
  return data.data.Viewer;
};

export const fetchMangaEntries = async (
  token: string,
  userId: number
): Promise<WipeListEntry[]> => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "user-agent": USER_AGENT
    },
    body: JSON.stringify({
      query: `query ($userId: Int) {
        MediaListCollection(userId: $userId, type: MANGA) {
          lists { entries { id media { id title { romaji english } } } }
        }
      }`,
      variables: { userId }
    })
  });
  if (!response.ok) {throw new Error(`Manga list fetch failed: HTTP ${response.status}`);}
  // SAFETY: parsed JSON matches { data?: { MediaListCollection?: { lists?: Array<{ entries?: Array<{ id: number; for this trusted/test payload
  const data = (await response.json()) as {
    data?: {
      MediaListCollection?: {
        lists?: Array<{
          entries?: Array<{
            id: number;
            media?: { id: number; title?: { romaji?: string | null; english?: string | null } };
          }>;
        }>;
      };
    };
  };
  const lists = data.data?.MediaListCollection?.lists ?? [];
  const seen = new Set<number>();
  const entries: WipeListEntry[] = [];
  for (const list of lists) {
    for (const entry of list.entries ?? []) {
      if (seen.has(entry.id)) {continue;}
      seen.add(entry.id);
      entries.push({
        id: entry.id,
        mediaId: entry.media?.id ?? 0,
        title:
          entry.media?.title?.english ??
          entry.media?.title?.romaji ??
          "Unknown",
      });
    }
  }
  return entries;
};

export const deleteEntry = async (token: string, entryId: number): Promise<boolean> => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "user-agent": USER_AGENT
    },
    body: JSON.stringify({
      query: `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
      variables: { id: entryId }
    })
  });
  // SAFETY: test/double or boundary cast through unknown to { errors?: unknown[] };
  const data = (await response.json()) as { errors?: unknown[] };
  if (data.errors) {return false;}
  return true;
};

// ---------- activities ----------

export type Activity =
  | { type: "MANGA_LIST"; id: number; status?: string; progress?: string | null; mediaTitle?: string }
  | { type: "TEXT"; id: number; text: string };

interface ActivitiesPage {
  hasNextPage: boolean;
  activities: Activity[];
}

const fetchActivitiesPage = async (
  token: string,
  userId: number,
  page: number
): Promise<ActivitiesPage> => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "user-agent": USER_AGENT
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
      variables: { userId, page }
    })
  });
  if (!response.ok) {throw new Error(`Activity page fetch failed: HTTP ${response.status}`);}
  // SAFETY: AniList activity page JSON is decoded via isJsonObject / field helpers below
  const data: unknown = await response.json();
  const envelope = isJsonObject(data) ? objectField(data, "data") : undefined;
  const pageRecord = envelope === undefined ? undefined : objectField(envelope, "Page");
  const activityItems = pageRecord === undefined
    ? []
    : (arrayField(pageRecord, "activities") ?? []).filter(isJsonObject);
  const activities: Activity[] = [];
  for (const item of activityItems) {
    const id = numberField(item, "id");
    if (id === undefined) {continue;}
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
            : stringField(title, "english") ?? stringField(title, "romaji") ?? "Unknown",
      });
    } else if (type === "TEXT") {
      activities.push({ type: "TEXT", id, text: stringField(item, "text") ?? "" });
    }
  }
  const pageInfo = pageRecord === undefined ? undefined : objectField(pageRecord, "pageInfo");
  return { activities, hasNextPage: pageInfo !== undefined && pageInfo.hasNextPage === true };
};

const MANGA_KEYWORDS = [
  "manga", "chapter", "volume", "read", "reading",
  "manhwa", "manhua", "webtoon", "light novel", "ln",
];

const isMangaRelatedActivity = (activity: Activity): boolean => {
  if (activity.type === "MANGA_LIST") {return true;}
  if (activity.type === "TEXT") {
    const text = activity.text.toLowerCase();
    return MANGA_KEYWORDS.some((keyword) => text.includes(keyword));
  }
  return false;
};

export const fetchMangaActivities = async (
  token: string,
  userId: number,
  report?: PhaseReporter
): Promise<Activity[]> => {
  const all: Activity[] = [];
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    const result = await fetchActivitiesPage(token, userId, page);
    for (const activity of result.activities) {
      if (isMangaRelatedActivity(activity)) {all.push(activity);}
    }
    report?.detail(
      `page ${page}: ${result.activities.length} activities (${all.length} manga-related so far)`
    );
    hasNextPage = result.hasNextPage;
    page += 1;
    await sleep(3000);
  }
  return all;
};

export const deleteActivity = async (
  token: string,
  activityId: number
): Promise<{ success: boolean; alreadyDeleted: boolean }> => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "user-agent": USER_AGENT
    },
    body: JSON.stringify({
      query: `mutation ($id: Int) { DeleteActivity(id: $id) { deleted } }`,
      variables: { id: activityId }
    })
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "60");
    await sleep(retryAfter * 1000);
    return deleteActivity(token, activityId);
  }
  if (response.status === 400) {
    const body = (await response.text()).includes("The selected id is invalid")
      ? { success: true, alreadyDeleted: true }
      : { success: false, alreadyDeleted: false };
    return body;
  }
  if (!response.ok) {return { success: false, alreadyDeleted: false };}
  return { success: true, alreadyDeleted: false };
};

export const deleteEntriesWithProgress = async (
  token: string,
  entries: readonly WipeListEntry[],
  report?: PhaseReporter
): Promise<{ ok: number; failed: number }> => {
  let ok = 0;
  let failed = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {continue;}
    try {
      if (await deleteEntry(token, entry.id)) {ok += 1;}
      else {failed += 1;}
    } catch {
      failed += 1;
    }
    report?.progress(index + 1, entries.length, [
      ["ok", ok],
      ["fail", failed],
    ]);
    await sleep(2500);
  }
  return { ok, failed };
};

export const deleteActivitiesWithProgress = async (
  token: string,
  activities: readonly Activity[],
  report?: PhaseReporter
): Promise<{ ok: number; failed: number; skipped: number }> => {
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    if (!activity) {continue;}
    const result = await deleteActivity(token, activity.id);
    if (result.alreadyDeleted) {skipped += 1;}
    else if (result.success) {ok += 1;}
    else {failed += 1;}
    report?.progress(index + 1, activities.length, [
      ["ok", ok],
      ["fail", failed],
      ["skip", skipped],
    ]);
    await sleep(3000);
  }
  return { ok, failed, skipped };
};
