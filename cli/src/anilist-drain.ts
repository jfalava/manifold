/**
 * Host-side AniList outbox drain (oci-agents / always-on CLI).
 *
 * Same contract as packages/paperback-runtime device drain:
 *   GET  /v1/ops/pending/anilist → execute GraphQL → POST /v1/ops/complete
 *
 * Runs on a non-Cloudflare egress IP (prefer IPv6). Does not import the
 * GPL paperback-runtime package; mutations mirror its semantics.
 */
import { ANILIST_GRAPHQL_ENDPOINT } from "@manifold/canonical/sources";
import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  objectField,
  stringField,
  type JsonObject,
} from "@manifold/json";
import { Effect } from "effect";

import {
  parsePendingAniListOp,
  toAniListGraphqlStatus,
  type AniListFieldChange,
  type PendingAniListOp,
} from "@/anilist-op-payload";

export type { PendingAniListOp };
import {
  cliError,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  platformFetch,
  runHost,
  sleep,
  type CliEffectError,
} from "@/effect-kit";

const USER_AGENT = manifoldUserAgent("cli-drain");

/** Stay under AniList ~30 req/min IP cap. */
const DEFAULT_REQUEST_INTERVAL_MS = 2_500;
let requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS;
const DRAIN_BATCH_LIMIT = 25;
const FMI_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DrainApiClient = {
  readonly pendingAniListOps: (limit?: number) => Promise<readonly PendingAniListOp[]>;
  readonly completeOps: (
    results: readonly {
      readonly opId: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly mediaListEntryId?: number;
    }[],
  ) => Promise<{ updated: number }>;
};

export type DrainPassSummary = {
  readonly fetched: number;
  readonly ok: number;
  readonly failed: number;
  readonly reported: number;
};

export type DrainOpResult = {
  readonly opId: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly mediaListEntryId?: number;
  readonly kind: string;
};

type FuzzyDateInput = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

let lastRequestAt = 0;

const throttleEffect = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const wait = requestIntervalMs - (epochMillisNow() - lastRequestAt);
    if (wait > 0) {
      yield* sleep(wait);
    }
    lastRequestAt = epochMillisNow();
  });

const errorText = (cause: unknown): string => {
  if (cause && typeof cause === "object" && "message" in cause && isString(cause.message)) {
    return cause.message;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
};

const gqlEffect = (
  token: string,
  query: string,
  variables: JsonObject = {},
  attempt = 0,
): Effect.Effect<JsonObject, CliEffectError> =>
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
      return yield* gqlEffect(token, query, variables, attempt + 1);
    }
    const raw = yield* jsonFromResponseEffect(response, "anilist.drain.gql");
    if (!isJsonObject(raw)) {
      return yield* cliError("AniList returned an invalid GraphQL response");
    }
    const errors = raw.errors;
    if (errors !== undefined && !isJsonArray(errors)) {
      return yield* cliError("AniList returned an invalid GraphQL errors envelope");
    }
    if (isJsonArray(errors) && errors.length > 0) {
      const messages = errors.map((error) =>
        isJsonObject(error) ? (stringField(error, "message") ?? "?") : "?",
      );
      return yield* cliError(messages.join("; "));
    }
    if (!response.ok) {
      return yield* cliError(`AniList HTTP ${response.status}`);
    }
    const data = objectField(raw, "data");
    if (!data) {
      return yield* cliError("AniList response missing data");
    }
    return data;
  });

const mediaIdOf = (anilistId: string): number => {
  if (!/^[1-9]\d*$/.test(anilistId)) {
    throw new Error(`Invalid AniList media id: ${anilistId}`);
  }
  const mediaId = Number(anilistId);
  if (!Number.isSafeInteger(mediaId) || mediaId < 1) {
    throw new Error(`Invalid AniList media id: ${anilistId}`);
  }
  return mediaId;
};

const fmiDate = (value: string | null): FuzzyDateInput | null => {
  if (value === null) {
    return null;
  }
  if (!FMI_DATE.test(value)) {
    throw new Error(`Invalid AniList date: ${value}; expected YYYY-MM-DD`);
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
    throw new Error(`Invalid AniList date: ${value}; expected a real calendar date`);
  }
  return { year, month, day };
};

const mediaIdEffect = (anilistId: string): Effect.Effect<number, CliEffectError> =>
  Effect.try({
    try: () => mediaIdOf(anilistId),
    catch: (cause) => cliError(errorText(cause)),
  });

const saveStatusEffect = (
  token: string,
  anilistId: string,
  status: ReturnType<typeof toAniListGraphqlStatus> | null,
): Effect.Effect<number | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const mediaId = yield* mediaIdEffect(anilistId);
    const data = yield* gqlEffect(
      token,
      `mutation ($mediaId: Int!, $status: MediaListStatus) {
        SaveMediaListEntry(mediaId: $mediaId, status: $status, private: true) {
          id status private
        }
      }`,
      { mediaId, status },
    );
    const entry = objectField(data, "SaveMediaListEntry");
    const id = entry?.id;
    return isFiniteNumber(id) ? id : undefined;
  });

const saveProgressEffect = (
  token: string,
  anilistId: string,
  progress: number,
): Effect.Effect<void, CliEffectError> =>
  Effect.gen(function* () {
    const mediaId = yield* mediaIdEffect(anilistId);
    const chapters = Math.floor(progress);
    if (!Number.isSafeInteger(chapters) || chapters < 1) {
      return;
    }
    // Status is never touched — collections own status transitions.
    yield* gqlEffect(
      token,
      `mutation ($mediaId: Int!, $progress: Int) {
        SaveMediaListEntry(mediaId: $mediaId, progress: $progress, private: true) {
          id progress status private
        }
      }`,
      { mediaId, progress: chapters },
    );
  });

const saveFieldsEffect = (
  token: string,
  anilistId: string,
  change: AniListFieldChange,
): Effect.Effect<void, CliEffectError> =>
  Effect.gen(function* () {
    const mediaId = yield* mediaIdEffect(anilistId);
    const variables = yield* Effect.try({
      try: (): JsonObject => ({
        mediaId,
        ...(change.status !== undefined && {
          status: change.status === null ? null : toAniListGraphqlStatus(change.status),
        }),
        ...(change.score !== undefined && { score: change.score }),
        ...(change.notes !== undefined && { notes: change.notes }),
        ...(change.startedAt !== undefined && { startedAt: fmiDate(change.startedAt) }),
        ...(change.completedAt !== undefined && { completedAt: fmiDate(change.completedAt) }),
        ...(change.volumeProgress !== undefined && { progressVolumes: change.volumeProgress }),
      }),
      catch: (cause) => cliError(errorText(cause)),
    });
    yield* gqlEffect(
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
    );
  });

const deleteEntryEffect = (
  token: string,
  mediaListEntryId: number,
): Effect.Effect<void, CliEffectError> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(mediaListEntryId) || mediaListEntryId < 1) {
      return yield* cliError(`Invalid AniList list entry id: ${mediaListEntryId}`);
    }
    const data = yield* gqlEffect(
      token,
      `mutation ($id: Int) {
        DeleteMediaListEntry(id: $id) { deleted }
      }`,
      { id: mediaListEntryId },
    );
    const deleted = objectField(data, "DeleteMediaListEntry")?.deleted;
    if (deleted !== true) {
      return yield* cliError(`DeleteMediaListEntry did not confirm deletion for ${mediaListEntryId}`);
    }
  });

const fetchMediaListEntryIdsEffect = (
  token: string,
  userId: number,
): Effect.Effect<Readonly<Record<string, number>>, CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* gqlEffect(
      token,
      `query ($userId: Int!) {
        MediaListCollection(userId: $userId, type: MANGA) {
          lists { entries { id mediaId } }
        }
      }`,
      { userId },
    );
    const ids: Record<string, number> = {};
    const collection = objectField(data, "MediaListCollection");
    const lists = collection?.lists;
    if (!isJsonArray(lists)) {
      return ids;
    }
    for (const list of lists) {
      if (!isJsonObject(list)) {
        continue;
      }
      const entries = list.entries;
      if (!isJsonArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        if (!isJsonObject(entry)) {
          continue;
        }
        const id = entry.id;
        const mediaId = entry.mediaId;
        if (isFiniteNumber(id) && isFiniteNumber(mediaId)) {
          ids[String(mediaId)] = id;
        }
      }
    }
    return ids;
  });

const fetchViewerIdEffect = (token: string): Effect.Effect<number, CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* gqlEffect(token, `query { Viewer { id } }`);
    const viewer = objectField(data, "Viewer");
    const id = viewer?.id;
    if (!isFiniteNumber(id)) {
      return yield* cliError("AniList returned no Viewer id");
    }
    return id;
  });

const executeOpEffect = (
  token: string,
  op: PendingAniListOp,
  mediaListEntryIds: Readonly<Record<string, number>> | undefined,
): Effect.Effect<number | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parsePendingAniListOp(op),
      catch: (cause) =>
        cliError(cause instanceof Error ? cause.message : `op ${op.opId}: parse failed`),
    });

    switch (parsed.kind) {
      case "anilist.status": {
        const status =
          parsed.status === null ? null : toAniListGraphqlStatus(parsed.status);
        return yield* saveStatusEffect(token, parsed.anilistId, status);
      }
      case "anilist.progress": {
        yield* saveProgressEffect(token, parsed.anilistId, parsed.progress);
        return undefined;
      }
      case "anilist.fields": {
        yield* saveFieldsEffect(token, parsed.anilistId, parsed.change);
        return parsed.mediaListEntryId;
      }
      case "anilist.delete": {
        let listEntryId = parsed.mediaListEntryId;
        if (listEntryId === undefined && mediaListEntryIds) {
          listEntryId = mediaListEntryIds[parsed.anilistId];
        }
        if (listEntryId === undefined) {
          return yield* cliError(
            `op ${parsed.opId}: no mediaListEntryId for ${parsed.anilistId}`,
          );
        }
        yield* deleteEntryEffect(token, listEntryId);
        return listEntryId;
      }
    }
  });

/**
 * One drain pass: fetch pending anilist:* ops, execute, report outcomes.
 * Empty queue is success with zeros.
 */
export const drainAniListOpsPassEffect = (
  api: DrainApiClient,
  anilistToken: string,
  options?: { readonly limit?: number },
): Effect.Effect<DrainPassSummary, CliEffectError> =>
  Effect.gen(function* () {
    const limit = options?.limit ?? DRAIN_BATCH_LIMIT;
    const ops = yield* fromPromise(() => api.pendingAniListOps(limit)).pipe(
      Effect.mapError((cause) => cliError(`pending AniList ops failed: ${errorText(cause)}`)),
    );
    if (ops.length === 0) {
      return { fetched: 0, ok: 0, failed: 0, reported: 0 };
    }

    const needsListEntryIds = ops.some(
      (op) => op.kind === "anilist.delete" && op.payload["mediaListEntryId"] === undefined,
    );
    const mediaListEntryIds = needsListEntryIds
      ? yield* Effect.gen(function* () {
          const userId = yield* fetchViewerIdEffect(anilistToken);
          return yield* fetchMediaListEntryIdsEffect(anilistToken, userId);
        })
      : undefined;

    const results: DrainOpResult[] = [];
    for (const op of ops) {
      const outcome = yield* executeOpEffect(anilistToken, op, mediaListEntryIds).pipe(
        Effect.map((mediaListEntryId) => ({
          ok: true as const,
          mediaListEntryId,
        })),
        Effect.catch((cause) =>
          Effect.succeed({ ok: false as const, error: errorText(cause) }),
        ),
      );
      if (!outcome.ok) {
        results.push({ opId: op.opId, ok: false, error: outcome.error, kind: op.kind });
        continue;
      }
      results.push({
        opId: op.opId,
        ok: true,
        kind: op.kind,
        ...(outcome.mediaListEntryId !== undefined && {
          mediaListEntryId: outcome.mediaListEntryId,
        }),
      });
    }

    const reportBody = results.map((r) => ({
      opId: r.opId,
      ok: r.ok,
      ...(r.error !== undefined && { error: r.error }),
      ...(r.mediaListEntryId !== undefined && { mediaListEntryId: r.mediaListEntryId }),
    }));

    const { updated } = yield* fromPromise(() => api.completeOps(reportBody)).pipe(
      Effect.mapError((cause) =>
        cliError(`complete ops failed: ${errorText(cause)}`),
      ),
    );

    return {
      fetched: ops.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      reported: updated,
    };
  });

export const drainAniListOpsPass = (
  api: DrainApiClient,
  anilistToken: string,
  options?: { readonly limit?: number },
): Promise<DrainPassSummary> =>
  runHost(drainAniListOpsPassEffect(api, anilistToken, options));

/** @internal test helper — expose gql throttling state reset if needed later */
export const __drainTest = {
  resetThrottle: (): void => {
    lastRequestAt = 0;
    requestIntervalMs = 0;
  },
  restoreThrottle: (): void => {
    lastRequestAt = 0;
    requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS;
  },
  parseOnly: parsePendingAniListOp,
  mediaIdOf,
  fmiDate: (value: string | null): FuzzyDateInput | null => fmiDate(value),
  toStatus: toAniListGraphqlStatus,
};

