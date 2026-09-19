/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex; modifications Copyright © 2026 Jorge Fernando Álava. */
/* Modified by Manifold on 2026-09-19. See ATTRIBUTIONS.md. */

/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import type { MalBackupIdentity } from "@manifold/canonical";
import { Data, Effect, Option, Schema } from "effect";
import { fromPromise } from "./from-promise.js";
import type { AniListReadingStatus } from "./anilist-types.js";
import {
  bridgeErrorDetail,
  errorMessage,
  PaperbackRuntimeError,
  paperbackError,
} from "./errors.js";

const ANILIST_GRAPHQL_ENDPOINT = "https://graphql.anilist.co";
const JsonBodyString = Schema.fromJsonString(Schema.Unknown);

export interface AniListLibraryItem {
  readonly anilistId: string;
  readonly status: AniListReadingStatus;
  readonly title: string;
  readonly coverUrl?: string;
}

interface GraphQLError {
  readonly message?: string;
  readonly status?: number | string;
}

interface GraphQLResponse {
  readonly data?: JsonValue;
  readonly errors?: readonly GraphQLError[];
}

type AniListDataDecoder<A> = (value: JsonValue) => A | undefined;

const decodeWithSchema =
  <A>(schema: Schema.ConstraintDecoder<A>): AniListDataDecoder<A> =>
  (value) => {
    const decoded = Schema.decodeOption(schema)(value);
    return Option.isSome(decoded) ? decoded.value : undefined;
  };

const decodeJsonObject = (value: JsonValue): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined;

const decodeGraphQLError = (value: JsonValue): GraphQLError | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const message = value.message;
  const status = value.status;
  if (
    (message !== undefined && !isString(message)) ||
    (status !== undefined && !isString(status) && !isFiniteNumber(status))
  ) {
    return undefined;
  }
  return {
    ...(isString(message) && { message }),
    ...((isString(status) || isFiniteNumber(status)) && { status }),
  };
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: raw response bytes enter here before GraphQL envelope validation
const decodeGraphQLResponse = (value: unknown): GraphQLResponse | undefined => {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const errorsValue = value.errors;
  if (errorsValue === undefined) {
    return { ...(value.data !== undefined && { data: value.data }) };
  }
  if (!isJsonArray(errorsValue)) {
    return undefined;
  }
  const errors: GraphQLError[] = [];
  for (const errorValue of errorsValue) {
    const error = decodeGraphQLError(errorValue);
    if (error === undefined) {
      return undefined;
    }
    errors.push(error);
  }
  return {
    ...(value.data !== undefined && { data: value.data }),
    errors,
  };
};

/** Thrown when AniList rejects the credentials (HTTP 401/403). */
export class AniListUnauthorizedError extends Data.TaggedError("AniListUnauthorizedError")<{}> {
  get message() {
    return "AniList rejected this token";
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

const gate = (): Effect.Effect<void, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const waitMs = Math.max(nextSlotAt - Date.now(), cooldownUntil - Date.now(), 0);
    if (waitMs > 0) {
      yield* fromPromise(() => Application.sleep(Math.ceil(waitMs / 1000)));
    }
    nextSlotAt = Math.max(Date.now(), nextSlotAt) + MIN_REQUEST_SPACING_MS;
  });

const headerValue = (headers: Record<string, string>, name: string): string | undefined => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
};

interface RawOutcome {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: GraphQLResponse;
}

const rawAniListRequest = (
  token: string,
  query: string,
  variables: JsonObject,
): Effect.Effect<RawOutcome, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const scheduled = yield* fromPromise(() =>
      Application.scheduleRequest({
        url: ANILIST_GRAPHQL_ENDPOINT,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": manifoldUserAgent("paperback-runtime"),
        },
        body: JSON.stringify({ query, variables }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        // Offline and other transport failures reject with message-less bridge
        // values; label the request so device logs stay actionable.
        paperbackError(`AniList request failed: ${bridgeErrorDetail(cause)}`),
      ),
    );
    const [response, bodyBuffer] = scheduled;
    const parsed = yield* Schema.decodeEffect(JsonBodyString)(
      Application.arrayBufferToUTF8String(bodyBuffer),
    ).pipe(Effect.orElseSucceed(() => undefined));
    const body = decodeGraphQLResponse(parsed);
    if (body === undefined) {
      return { status: response.status, headers: response.headers ?? {} };
    }
    return {
      status: response.status,
      headers: response.headers ?? {},
      body,
    };
  });

const isThrottled = (outcome: RawOutcome): boolean => {
  if (outcome.status === 429) {
    return true;
  }
  return (outcome.body?.errors ?? []).some(
    (error) =>
      error.status === 429 || (error.message !== undefined && THROTTLE_MESSAGE.test(error.message)),
  );
};

const scheduleCooldown = (headers: Record<string, string>): void => {
  const raw = headerValue(headers, "retry-after");
  const seconds = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  const waitSeconds =
    Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
  cooldownUntil = Math.max(cooldownUntil, Date.now() + waitSeconds * 1000 + COOLDOWN_BUFFER_MS);
};

const interpretOutcome = <A>(outcome: RawOutcome, decode: AniListDataDecoder<A>): A => {
  if (outcome.status === 401 || outcome.status === 403) {
    throw new AniListUnauthorizedError();
  }
  if (outcome.body === undefined) {
    throw paperbackError(`AniList returned non-JSON response (HTTP ${outcome.status})`);
  }
  if (outcome.body.errors && outcome.body.errors.length > 0) {
    throw paperbackError(
      `AniList error: ${outcome.body.errors.map((e) => e.message ?? "?").join("; ")}`,
    );
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    throw paperbackError(`AniList request failed with HTTP ${outcome.status}`);
  }
  const data = outcome.body.data;
  if (data === undefined) {
    throw paperbackError("AniList response missing data");
  }
  const decoded = decode(data);
  if (decoded === undefined) {
    throw paperbackError("AniList response data failed validation");
  }
  return decoded;
};

const aniListRequestEffect = <A>(
  token: string,
  query: string,
  variables: JsonObject = {},
  decode: AniListDataDecoder<A>,
): Effect.Effect<A, PaperbackRuntimeError | AniListUnauthorizedError> =>
  Effect.gen(function* () {
    for (let attempt = 1; ; attempt += 1) {
      yield* gate();
      const outcome = yield* rawAniListRequest(token, query, variables);
      if (!isThrottled(outcome)) {
        return yield* Effect.try({
          try: () => interpretOutcome(outcome, decode),
          catch: (cause) =>
            cause instanceof AniListUnauthorizedError ? cause : paperbackError(errorMessage(cause)),
        });
      }
      if (attempt > MAX_THROTTLED_RETRIES) {
        return yield* paperbackError("AniList kept rate limiting after repeated backoff");
      }
      scheduleCooldown(outcome.headers);
    }
  });

// Paperback's JS runtime exposes no global fetch; requests must go through
// Application.scheduleRequest.
export const aniListRequest = async <A>(
  token: string,
  query: string,
  variables: JsonObject = {},
  decode: AniListDataDecoder<A>,
): Promise<A> =>
  enqueue(() => Effect.runPromise(aniListRequestEffect(token, query, variables, decode)));

export interface AniListViewer {
  readonly Viewer: {
    readonly id: number;
    readonly name: string;
  };
}

const AniListViewerSchema = Schema.Struct({
  Viewer: Schema.Struct({
    id: Schema.Finite,
    name: Schema.String,
  }),
});

export const decodeAniListViewer = decodeWithSchema<AniListViewer>(AniListViewerSchema);

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

const LibraryDataSchema = Schema.Struct({
  MediaListCollection: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        lists: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                entries: Schema.optional(
                  Schema.NullOr(
                    Schema.Array(
                      Schema.Struct({
                        status: Schema.optional(Schema.NullOr(Schema.String)),
                        media: Schema.optional(
                          Schema.NullOr(
                            Schema.Struct({
                              id: Schema.optional(Schema.Finite),
                              title: Schema.optional(
                                Schema.NullOr(
                                  Schema.Struct({
                                    userPreferred: Schema.optional(Schema.NullOr(Schema.String)),
                                    romaji: Schema.optional(Schema.NullOr(Schema.String)),
                                    english: Schema.optional(Schema.NullOr(Schema.String)),
                                  }),
                                ),
                              ),
                              coverImage: Schema.optional(
                                Schema.NullOr(
                                  Schema.Struct({
                                    large: Schema.optional(Schema.NullOr(Schema.String)),
                                    medium: Schema.optional(Schema.NullOr(Schema.String)),
                                  }),
                                ),
                              ),
                            }),
                          ),
                        ),
                      }),
                    ),
                  ),
                ),
              }),
            ),
          ),
        ),
      }),
    ),
  ),
});

type LibraryData = Schema.Schema.Type<typeof LibraryDataSchema>;
const decodeLibraryData = decodeWithSchema<LibraryData>(LibraryDataSchema);

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

const titleValue = (value: string | null | undefined): string | undefined =>
  value !== undefined && value !== null && value.trim().length > 0 ? value.trim() : undefined;

const fetchAniListLibraryEffect = (
  token: string,
  userId: number,
): Effect.Effect<readonly AniListLibraryItem[], PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const data = yield* fromPromise(() =>
      aniListRequest(token, LIBRARY_QUERY, { userId }, decodeLibraryData),
    );

    const items = new Map<string, AniListLibraryItem>();
    for (const list of data.MediaListCollection?.lists ?? []) {
      for (const entry of list.entries ?? []) {
        const mediaId = entry.media?.id;
        const status = entry.status ? normalizeAniListStatus(entry.status) : undefined;
        if (!mediaId || !status) {
          continue;
        }

        const key = String(mediaId);
        if (items.get(key)?.status === "re_reading") {
          continue;
        }

        const titles = entry.media?.title;
        items.set(key, {
          anilistId: key,
          status,
          title:
            titleValue(titles?.userPreferred) ??
            titleValue(titles?.english) ??
            titleValue(titles?.romaji) ??
            `AniList ${mediaId}`,
          ...(titleValue(entry.media?.coverImage?.large) && {
            coverUrl: titleValue(entry.media?.coverImage?.large),
          }),
        });
      }
    }
    return [...items.values()];
  });

export const fetchAniListLibrary = (
  token: string,
  userId: number,
): Promise<readonly AniListLibraryItem[]> =>
  Effect.runPromise(fetchAniListLibraryEffect(token, userId));

const GRAPHQL_INT_MAX = 2_147_483_647;
const ANILIST_ID = /^[1-9]\d*$/;

const mediaIdOf = (anilistId: string): number => {
  if (!ANILIST_ID.test(anilistId)) {
    throw paperbackError(`Invalid AniList manga id: ${anilistId}`);
  }
  const mediaId = Number(anilistId);
  if (!Number.isSafeInteger(mediaId) || mediaId > GRAPHQL_INT_MAX) {
    throw paperbackError(`Invalid AniList manga id: ${anilistId}`);
  }
  return mediaId;
};

const SavedStatusDataSchema = Schema.Struct({
  SaveMediaListEntry: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.Finite),
        media: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              idMal: Schema.optional(Schema.NullOr(Schema.Finite)),
              title: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    english: Schema.optional(Schema.NullOr(Schema.String)),
                    romaji: Schema.optional(Schema.NullOr(Schema.String)),
                    native: Schema.optional(Schema.NullOr(Schema.String)),
                  }),
                ),
              ),
              synonyms: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
            }),
          ),
        ),
      }),
    ),
  ),
});

type SavedStatusData = Schema.Schema.Type<typeof SavedStatusDataSchema>;
const decodeSavedStatusData = decodeWithSchema<SavedStatusData>(SavedStatusDataSchema);

const saveAniListStatusEffect = (
  token: string,
  anilistId: string,
  status: AniListReadingStatus | null,
): Effect.Effect<
  { mediaListEntryId?: number; backupIdentity?: MalBackupIdentity },
  PaperbackRuntimeError
> =>
  Effect.gen(function* () {
    const mediaId = yield* Effect.try({
      try: () => mediaIdOf(anilistId),
      catch: (cause) => paperbackError(errorMessage(cause)),
    });
    // Privacy policy: everything this source touches stays private.
    const data = yield* fromPromise(() =>
      aniListRequest(
        token,
        `mutation ($mediaId: Int!, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, status: $status, private: true) {
        id status private
        media { idMal title { english romaji native } synonyms }
      }
    }`,
        { mediaId, status: status === null ? null : toAniListStatus(status) },
        decodeSavedStatusData,
      ),
    );
    const entryId = data.SaveMediaListEntry?.id;
    const media = data.SaveMediaListEntry?.media;
    return {
      ...(entryId !== undefined && { mediaListEntryId: entryId }),
      ...(media && {
        backupIdentity: {
          anilistId,
          ...(media.idMal != null && media.idMal > 0 && { malId: String(media.idMal) }),
          titles: [
            ...new Set(
              [
                media.title?.english,
                media.title?.romaji,
                media.title?.native,
                ...(media.synonyms ?? []),
              ].flatMap((title) => (title?.trim() ? [title.trim()] : [])),
            ),
          ],
        },
      }),
    };
  });

export const saveAniListStatus = (
  token: string,
  anilistId: string,
  status: AniListReadingStatus | null,
): Promise<{ mediaListEntryId?: number; backupIdentity?: MalBackupIdentity }> =>
  Effect.runPromise(saveAniListStatusEffect(token, anilistId, status));

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

const FMI_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** AniList GraphQL FuzzyDateInput for startedAt / completedAt mutations. */
export type FuzzyDateInput = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

const fmiDate = (value: string | null): FuzzyDateInput | null => {
  if (value === null) {
    return null;
  }
  if (!FMI_DATE.test(value)) {
    throw paperbackError(`Invalid AniList date: ${value}; expected YYYY-MM-DD`);
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month === 2
      ? isLeapYear
        ? 29
        : 28
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw paperbackError(`Invalid AniList date: ${value}; expected a real calendar date`);
  }
  return { year, month, day };
};

const saveAniListFieldsEffect = (
  token: string,
  anilistId: string,
  change: AniListFieldChange,
): Effect.Effect<void, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const mediaId = yield* Effect.try({
      try: () => mediaIdOf(anilistId),
      catch: (cause) => paperbackError(errorMessage(cause)),
    });
    const variables = yield* Effect.try({
      try: () => ({
        mediaId,
        ...(!(change.status === undefined) && {
          status: change.status === null ? null : toAniListStatus(change.status),
        }),
        ...(!(change.score === undefined) && { score: change.score }),
        ...(!(change.notes === undefined) && { notes: change.notes }),
        ...(!(change.startedAt === undefined) && { startedAt: fmiDate(change.startedAt) }),
        ...(!(change.completedAt === undefined) && { completedAt: fmiDate(change.completedAt) }),
        ...(!(change.volumeProgress === undefined) && { progressVolumes: change.volumeProgress }),
      }),
      catch: (cause) => paperbackError(errorMessage(cause)),
    });
    yield* fromPromise(() =>
      aniListRequest(
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
        variables,
        decodeJsonObject,
      ),
    );
  });

export const saveAniListFields = (
  token: string,
  anilistId: string,
  change: AniListFieldChange,
): Promise<void> => Effect.runPromise(saveAniListFieldsEffect(token, anilistId, change));

/** Deletes the list entry outright. Requires its numeric mediaListEntry id. */
const DeleteMediaListEntryDataSchema = Schema.Struct({
  DeleteMediaListEntry: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        deleted: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

const decodeDeleteMediaListEntryData = decodeWithSchema(DeleteMediaListEntryDataSchema);

const deleteAniListEntryEffect = (
  token: string,
  mediaListEntryId: number,
): Effect.Effect<boolean, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(mediaListEntryId) ||
      mediaListEntryId < 1 ||
      mediaListEntryId > GRAPHQL_INT_MAX
    ) {
      return yield* paperbackError(`Invalid AniList list entry id: ${mediaListEntryId}`);
    }
    const data = yield* fromPromise(() =>
      aniListRequest(
        token,
        `mutation ($id: Int) {
      DeleteMediaListEntry(id: $id) { deleted }
    }`,
        { id: mediaListEntryId },
        decodeDeleteMediaListEntryData,
      ),
    );
    return data.DeleteMediaListEntry?.deleted === true;
  });

export const deleteAniListEntry = (token: string, mediaListEntryId: number): Promise<boolean> =>
  Effect.runPromise(deleteAniListEntryEffect(token, mediaListEntryId));

/**
 * Batch-fetches numeric list entry ids for media ids. Deletion on AniList is
 * keyed by the list-entry row, not the media row, so nukes need these.
 */
const MediaListEntryIdsDataSchema = Schema.Struct({
  MediaListCollection: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        lists: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                entries: Schema.optional(
                  Schema.NullOr(
                    Schema.Array(
                      Schema.Struct({
                        id: Schema.optional(Schema.Finite),
                        mediaId: Schema.optional(Schema.Finite),
                      }),
                    ),
                  ),
                ),
              }),
            ),
          ),
        ),
      }),
    ),
  ),
});

type MediaListEntryIdsData = Schema.Schema.Type<typeof MediaListEntryIdsDataSchema>;
const decodeMediaListEntryIdsData = decodeWithSchema<MediaListEntryIdsData>(
  MediaListEntryIdsDataSchema,
);

const fetchAniListMediaListEntryIdsEffect = (
  token: string,
  userId: number,
): Effect.Effect<Readonly<Record<string, number>>, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const data = yield* fromPromise(() =>
      aniListRequest(
        token,
        `query ($userId: Int!) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists { entries { id mediaId } }
      }
    }`,
        { userId },
        decodeMediaListEntryIdsData,
      ),
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
  });

export const fetchAniListMediaListEntryIds = (
  token: string,
  userId: number,
): Promise<Readonly<Record<string, number>>> =>
  Effect.runPromise(fetchAniListMediaListEntryIdsEffect(token, userId));

const saveAniListProgressEffect = (
  token: string,
  anilistId: string,
  progress: number,
): Effect.Effect<boolean, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const mediaId = yield* Effect.try({
      try: () => mediaIdOf(anilistId),
      catch: (cause) => paperbackError(errorMessage(cause)),
    });
    // AniList tracks whole chapters only; fractional releases (e.g. 38.5)
    // normalize down to their integer part. Below 1 there is nothing to push.
    const chapters = Math.floor(progress);
    if (!Number.isSafeInteger(chapters) || chapters < 1) {
      return false;
    }
    // Status is NEVER touched here — collections own status transitions.
    // Reading a DROPPED title bumps its progress and stays DROPPED; omitting
    // the field preserves whatever AniList already has (creating a private
    // CURRENT entry only when the title is unlisted, mirroring AniList's own
    // mark-as-read behaviour).
    yield* fromPromise(() =>
      aniListRequest(
        token,
        `mutation ($mediaId: Int!, $progress: Int) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, private: true) {
        id progress status private
      }
    }`,
        { mediaId, progress: chapters },
        decodeJsonObject,
      ),
    );
    return true;
  });

export const saveAniListProgress = (
  token: string,
  anilistId: string,
  progress: number,
): Promise<boolean> => Effect.runPromise(saveAniListProgressEffect(token, anilistId, progress));
