import { isJsonObject, type JsonObject } from "@manifold/json";
import type { AniListReadingStatus } from "./anilist-types.js";

const ANILIST_GRAPHQL_ENDPOINT = "https://graphql.anilist.co";

export interface AniListLibraryItem {
  readonly anilistId: string;
  readonly status: AniListReadingStatus;
  readonly title: string;
  readonly coverUrl?: string;
}

interface GraphQLResponse<A> {
  readonly data?: A;
  readonly errors?: readonly { readonly message?: string; status?: number | string }[];
}

/** Thrown when AniList rejects the credentials (HTTP 401/403). */
export class AniListUnauthorizedError extends Error {
  constructor() {
    super("AniList rejected this token");
    this.name = "AniListUnauthorizedError";
  }
}

// AniList rate-limits per IP (~30 requests/minute at present) and answers 429
// with a retry-after header once exceeded. Every GraphQL call funnels through
// aniListRequest, so politeness lives here: traffic is fully serialized,
// request starts are spaced MIN_REQUEST_SPACING_MS apart, and any 429 freezes
// ALL AniList calls for the server-provided retry-after window before the
// failed call is retried.
const MIN_REQUEST_SPACING_MS = 3_000;
const MAX_THROTTLED_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const COOLDOWN_BUFFER_MS = 1_000;
const THROTTLE_MESSAGE = /too many requests/i;

let queueTail: Promise<unknown> = Promise.resolve();
let nextSlotAt = 0;
let cooldownUntil = 0;

const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queueTail.then(task);
  // Failures must never stall the callers queued behind them.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const gate = async (): Promise<void> => {
  const waitMs = Math.max(nextSlotAt - Date.now(), cooldownUntil - Date.now(), 0);
  if (waitMs > 0) {await Application.sleep(Math.ceil(waitMs / 1000));}
  nextSlotAt = Math.max(Date.now(), nextSlotAt) + MIN_REQUEST_SPACING_MS;
};

const headerValue = (headers: Record<string, string>, name: string): string | undefined => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {return value;}
  }
  return undefined;
};

interface RawOutcome<A> {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: GraphQLResponse<A>;
}

const rawAniListRequest = async <A>(
  token: string,
  query: string,
  variables: JsonObject,
): Promise<RawOutcome<A>> => {
  const [response, bodyBuffer] = await Application.scheduleRequest({
    url: ANILIST_GRAPHQL_ENDPOINT,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  try {
    // SAFETY: I/O JSON.parse of the AniList GraphQL HTTP body at the scheduleRequest boundary.
    const parsed: unknown = JSON.parse(
      Application.arrayBufferToUTF8String(bodyBuffer),
    );
    if (!isJsonObject(parsed)) {
      return { status: response.status, headers: response.headers ?? {} };
    }
    // SAFETY: JSON object is the GraphQL envelope; interpretOutcome reads data/errors.
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: parsed as GraphQLResponse<A>,
    };
  } catch {
    // Non-JSON payload (e.g. an HTML error page); the HTTP status decides.
    return { status: response.status, headers: response.headers ?? {} };
  }
};

const isThrottled = <A>(outcome: RawOutcome<A>): boolean => {
  if (outcome.status === 429) {return true;}
  return (outcome.body?.errors ?? []).some(
    (error) =>
      error.status === 429 ||
      (error.message !== undefined && THROTTLE_MESSAGE.test(error.message)),
  );
};

const scheduleCooldown = (headers: Record<string, string>): void => {
  const raw = headerValue(headers, "retry-after");
  const seconds = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  const waitSeconds =
    Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
  cooldownUntil = Math.max(
    cooldownUntil,
    Date.now() + waitSeconds * 1000 + COOLDOWN_BUFFER_MS,
  );
};

const interpretOutcome = <A>(outcome: RawOutcome<A>): A => {
  if (outcome.body === undefined) {
    throw new Error(`AniList returned non-JSON response (HTTP ${outcome.status})`);
  }
  if (outcome.body.errors && outcome.body.errors.length > 0) {
    throw new Error(
      `AniList error: ${outcome.body.errors.map((e) => e.message ?? "?").join("; ")}`,
    );
  }
  if (outcome.status === 401 || outcome.status === 403) {
    throw new AniListUnauthorizedError();
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new Error(`AniList request failed with HTTP ${outcome.status}`);
  }
  // SAFETY: value matches A at this call site
  return outcome.body.data as A;
};

// Paperback's JS runtime exposes no global fetch; requests must go through
// Application.scheduleRequest.
export const aniListRequest = async <A>(
  token: string,
  query: string,
  variables: JsonObject = {},
): Promise<A> =>
  enqueue(async () => {
    for (let attempt = 1; ; attempt += 1) {
      await gate();
      const outcome = await rawAniListRequest<A>(token, query, variables);
      if (!isThrottled(outcome)) {return interpretOutcome(outcome);}
      if (attempt > MAX_THROTTLED_RETRIES) {
        throw new Error("AniList kept rate limiting after repeated backoff");
      }
      scheduleCooldown(outcome.headers);
    }
  });

export interface AniListViewer {
  readonly Viewer: {
    readonly id: number;
    readonly name: string;
  };
}

export const viewerQuery = `
query {
  Viewer { id name }
}`;

const LIBRARY_QUERY = `
query ($userId: Int!) {
  MediaListCollection(userId: $userId, type: MANGA) {
    lists {
      entries {
        status
        media {
          id
          title { userPreferred romaji english }
          coverImage { large medium }
        }
      }
    }
  }
}`;

interface LibraryData {
  readonly MediaListCollection?: {
    readonly lists?: readonly {
      readonly entries?: readonly {
        readonly status?: string;
        readonly media?: {
          readonly id?: number;
          readonly title?: {
            readonly userPreferred?: string;
            readonly romaji?: string;
            readonly english?: string;
          };
          readonly coverImage?: {
            readonly large?: string;
            readonly medium?: string;
          };
        };
      }[];
    }[];
  };
}

// Registry vocabulary -> AniList enum. toUpperCase is WRONG here: only
// dropped/completed coincide; reading must become CURRENT, on_hold PAUSED,
// plan_to_read PLANNING, re_reading REPEATING.
export const toAniListStatus = (
  status: AniListReadingStatus,
): "CURRENT" | "PLANNING" | "COMPLETED" | "DROPPED" | "PAUSED" | "REPEATING" => {
  switch (status) {
    case "reading":
      return "CURRENT";
    case "on_hold":
      return "PAUSED";
    case "plan_to_read":
      return "PLANNING";
    case "re_reading":
      return "REPEATING";
    case "completed":
      return "COMPLETED";
    case "dropped":
      return "DROPPED";
  }
};

export const normalizeAniListStatus = (status: string): AniListReadingStatus | undefined => {
  switch (status) {
    case "CURRENT":
      return "reading";
    case "PLANNING":
      return "plan_to_read";
    case "PAUSED":
      return "on_hold";
    case "DROPPED":
      return "dropped";
    case "COMPLETED":
      return "completed";
    case "REPEATING":
      return "re_reading";
    default:
      return undefined;
  }
};

const titleValue = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value.trim() : undefined;

export const fetchAniListLibrary = async (
  token: string,
  userId: number,
): Promise<readonly AniListLibraryItem[]> => {
  const data = await aniListRequest<LibraryData>(token, LIBRARY_QUERY, { userId });

  const items = new Map<string, AniListLibraryItem>();
  for (const list of data.MediaListCollection?.lists ?? []) {
    for (const entry of list.entries ?? []) {
      const mediaId = entry.media?.id;
      const status = entry.status ? normalizeAniListStatus(entry.status) : undefined;
      if (!mediaId || !status) {continue;}

      const key = String(mediaId);
      if (items.get(key)?.status === "re_reading") {continue;}

      const titles = entry.media?.title;
      items.set(key, {
        anilistId: key,
        status,
        title:
          titleValue(titles?.userPreferred) ??
          titleValue(titles?.english) ??
          titleValue(titles?.romaji) ??
          `AniList ${mediaId}`,
        ...(titleValue(entry.media?.coverImage?.large) && { coverUrl: titleValue(entry.media?.coverImage?.large) }),
      });
    }
  }
  return [...items.values()];
};

export const saveAniListStatus = async (
  token: string,
  anilistId: string,
  status: AniListReadingStatus | null,
): Promise<{ mediaListEntryId?: number }> => {
  const mediaId = Number.parseInt(anilistId, 10);
  if (!Number.isSafeInteger(mediaId)) {throw new Error(`Invalid AniList manga id: ${anilistId}`);}
  // Privacy policy: everything this source touches stays private.
  const data = await aniListRequest<{ SaveMediaListEntry?: { id?: number } }>(
    token,
    `mutation ($mediaId: Int!, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status, private: true) { id status private }
    }`,
    { mediaId, status: status === null ? null : toAniListStatus(status) },
  );
  const entryId = data.SaveMediaListEntry?.id;
  return entryId === undefined ? {} : { mediaListEntryId: entryId };
};

// Score / notes / dates / volumes — the fields Paperback has no UI for.
// Managed by the admin panel and drained to AniList by this device.
export interface AniListFieldChange {
  readonly status?: AniListReadingStatus | null;
  readonly score?: number | null;
  readonly notes?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly volumeProgress?: number | null;
}

const FMI_DATE = /\d{4}-\d{2}-\d{2}/;

/** AniList GraphQL FuzzyDateInput for startedAt / completedAt mutations. */
export type FuzzyDateInput = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

const fmiDate = (value: string | null | undefined): FuzzyDateInput | undefined =>
  value == null || !FMI_DATE.test(value)
    ? undefined
    : {
        year: Number(value.slice(0, 4)),
        month: Number(value.slice(5, 7)),
        day: Number(value.slice(8, 10)),
      };

export const saveAniListFields = async (
  token: string,
  anilistId: string,
  change: AniListFieldChange,
): Promise<void> => {
  const mediaId = Number.parseInt(anilistId, 10);
  if (!Number.isSafeInteger(mediaId)) {throw new Error(`Invalid AniList manga id: ${anilistId}`);}
  await aniListRequest(
    token,
    `mutation (
      $mediaId: Int!, $status: MediaListStatus, $score: Float, $notes: String,
      $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput, $progressVolumes: Int
    ) {
      SaveMediaListEntry(
        mediaId: $mediaId, status: $status, score: $score, notes: $notes,
        startedAt: $startedAt, completedAt: $completedAt, progressVolumes: $progressVolumes,
        private: true
      ) { id status score notes private }
    }`,
    {
      mediaId,
      ...(!(change.status === undefined) && { status: change.status === null ? null : toAniListStatus(change.status) }),
      ...(!(change.score === undefined) && { score: change.score }),
      ...(!(change.notes === undefined) && { notes: change.notes }),
      ...(!(change.startedAt === undefined) && { startedAt: fmiDate(change.startedAt) ?? null }),
      ...(!(change.completedAt === undefined) && { completedAt: fmiDate(change.completedAt) ?? null }),
      ...(!(change.volumeProgress === undefined) && { progressVolumes: change.volumeProgress }),
    },
  );
};

/** Deletes the list entry outright. Requires its numeric mediaListEntry id. */
export const deleteAniListEntry = async (
  token: string,
  mediaListEntryId: number,
): Promise<boolean> => {
  const data = await aniListRequest<{ DeleteMediaListEntry?: { deleted?: boolean } }>(
    token,
    `mutation ($id: Int) {
      DeleteMediaListEntry(id: $id) { deleted }
    }`,
    { id: mediaListEntryId },
  );
  return data.DeleteMediaListEntry?.deleted === true;
};

/**
 * Batch-fetches numeric list entry ids for media ids. Deletion on AniList is
 * keyed by the list-entry row, not the media row, so nukes need these.
 */
export const fetchAniListMediaListEntryIds = async (
  token: string,
  userId: number,
): Promise<Readonly<Record<string, number>>> => {
  const data = await aniListRequest<{
    MediaListCollection?: {
      lists?: readonly { entries?: readonly { id?: number; mediaId?: number }[] }[];
    };
  }>(
    token,
    `query ($userId: Int!) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists { entries { id mediaId } }
      }
    }`,
    { userId },
  );
  const ids: Record<string, number> = {};
  for (const list of data.MediaListCollection?.lists ?? []) {
    for (const entry of list.entries ?? []) {
      if (entry.id !== undefined && entry.mediaId !== undefined) {
        ids[String(entry.mediaId)] = entry.id;
      }
    }
  }
  return ids;
};

export const saveAniListProgress = async (
  token: string,
  anilistId: string,
  progress: number,
): Promise<boolean> => {
  const mediaId = Number.parseInt(anilistId, 10);
  if (!Number.isSafeInteger(mediaId)) {throw new Error(`Invalid AniList manga id: ${anilistId}`);}
  // AniList tracks whole chapters only; fractional releases (e.g. 38.5)
  // normalize down to their integer part. Below 1 there is nothing to push.
  const chapters = Math.floor(progress);
  if (!Number.isSafeInteger(chapters) || chapters < 1) {return false;}
  // Status is NEVER touched here — collections own status transitions.
  // Reading a DROPPED title bumps its progress and stays DROPPED; omitting
  // the field preserves whatever AniList already has (creating a private
  // CURRENT entry only when the title is unlisted, mirroring AniList's own
  // mark-as-read behaviour).
  await aniListRequest(
    token,
    `mutation ($mediaId: Int!, $progress: Int) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, private: true) {
        id progress status private
      }
    }`,
    { mediaId, progress: chapters },
  );
  return true;
};
