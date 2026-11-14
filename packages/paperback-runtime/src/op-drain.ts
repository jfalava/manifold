/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import { isFiniteNumber, isString } from "@manifold/json";
import { Effect } from "effect";
import { fromPromise } from "./from-promise.js";
import { ANILIST_SESSION_KEY, ANILIST_VIEWER_ID_KEY } from "./anilist-types.js";
import { errorMessage, PaperbackRuntimeError, paperbackError } from "./errors.js";
import {
  AniListUnavailableError,
  decodeAniListViewer,
  fromAniListPromise,
  isAniListServiceFailure,
  viewerQuery,
  type AniListServiceFailure,
} from "./anilist-graphql.js";
import {
  aniListRequest,
  deleteAniListEntry,
  fetchAniListMediaListEntryIds,
  saveAniListFields,
  saveAniListProgress,
  saveAniListStatus,
} from "./anilist-device.js";
import type { PendingSyncOp } from "./api.js";
import { parsePendingAniListOp } from "@manifold/contract";
import { configuredPersonalApi } from "./runtime.js";

// Remote mutations (admin panel, CLI, migration) land as pending anilist:*
// ops in the personal API's op log. Workers can never reach AniList (its CDN
// blocks Cloudflare egress IPs), so THIS device drains them: any source
// network activity piggybacks a throttled drain, executing the ops on the
// device's own IP with the locally stored token.
const DRAIN_MIN_INTERVAL_MS = 60_000;

// A failed attempt (offline, gateway error) must not burn the full window:
// the next piggyback retries soon so reconnects drain promptly.
const DRAIN_RETRY_INTERVAL_MS = 15_000;
const DRAIN_BATCH_LIMIT = 25;

let lastDrainAt = 0;
let lastAttemptAt = 0;
let drainInFlight: Promise<void> | undefined;

const aniListToken = (): string | undefined => {
  const token = Application.getSecureState(ANILIST_SESSION_KEY);

  return isString(token) && token.trim().length > 0 ? token.trim() : undefined;
};

const aniListUserId = (): number | undefined => {
  const raw = Application.getState(ANILIST_VIEWER_ID_KEY);

  if (!isString(raw) && !isFiniteNumber(raw)) {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const executeOp = (
  token: string,
  op: PendingSyncOp,
  mediaListEntryIds: Record<string, number> | undefined,
): Effect.Effect<number | undefined, PaperbackRuntimeError | AniListServiceFailure> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parsePendingAniListOp(op),
      catch: (cause) => paperbackError(errorMessage(cause)),
    });

    switch (parsed.kind) {
      case "anilist.status": {
        const result = yield* fromAniListPromise(() =>
          saveAniListStatus(token, parsed.anilistId, parsed.status),
        );

        return result.mediaListEntryId;
      }

      case "anilist.progress": {
        yield* fromAniListPromise(() =>
          saveAniListProgress(token, parsed.anilistId, parsed.progress),
        );

        return undefined;
      }

      case "anilist.fields": {
        yield* fromAniListPromise(() => saveAniListFields(token, parsed.anilistId, parsed.change));

        return parsed.mediaListEntryId;
      }

      case "anilist.delete": {
        if (mediaListEntryIds !== undefined && mediaListEntryIds[parsed.anilistId] === undefined) {
          // When the lookup completed and the title is absent, the desired
          // state is already true. This also makes a delete replay safe after
          // the device applied it but the completion acknowledgement was lost.
          return undefined;
        }

        const listEntryId = mediaListEntryIds?.[parsed.anilistId] ?? parsed.mediaListEntryId;

        if (listEntryId === undefined) {
          return yield* paperbackError(
            `op ${parsed.opId}: no mediaListEntryId for ${parsed.anilistId}`,
          );
        }

        const deleted = yield* fromAniListPromise(() => deleteAniListEntry(token, listEntryId));

        if (!deleted) {
          return yield* paperbackError(
            `op ${parsed.opId}: AniList did not confirm deleting ${listEntryId}`,
          );
        }

        return listEntryId;
      }
    }
  });

/**
 * Whether AniList answers a request that no op can break. Asked after an op
 * got HTTP 5xx, to tell an outage from a request AniList cannot handle.
 */
const aniListAnswers = (token: string): Effect.Effect<boolean> =>
  fromAniListPromise(() => aniListRequest(token, viewerQuery, {}, decodeAniListViewer)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const opTitle = (op: PendingSyncOp): string | undefined => {
  const anilistId = op.payload["anilistId"];

  return isString(anilistId) ? anilistId : undefined;
};

const drainAniListOpsEffect = () =>
  Effect.gen(function* () {
    const token = aniListToken();

    if (!token) {
      return;
    }

    const api = configuredPersonalApi();
    const ops = yield* fromPromise(() => api.pendingAniListOps(DRAIN_BATCH_LIMIT));

    if (ops.length === 0) {
      return;
    }

    const needsListEntryIds = ops.some((op) => op.kind === "anilist.delete");
    const userId = aniListUserId();

    const mediaListEntryIds =
      needsListEntryIds && userId !== undefined
        ? yield* fromPromise(() => fetchAniListMediaListEntryIds(token, userId))
        : undefined;

    const results: {
      opId: string;
      ok: boolean;
      error?: string;
      mediaListEntryId?: number;
    }[] = [];

    let stoppedBy: AniListServiceFailure | undefined;

    // Titles whose op got HTTP 5xx in this pass. Their later ops wait for the
    // retry, so a newer change is never applied before an older one.
    const waiting = new Set<string>();

    for (const op of ops) {
      const title = opTitle(op);

      if (title !== undefined && waiting.has(title)) {
        continue;
      }

      const outcome = yield* executeOp(token, op, mediaListEntryIds).pipe(
        Effect.map((mediaListEntryId) => ({ ok: true as const, mediaListEntryId })),
        Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
      );

      if (!outcome.ok && isAniListServiceFailure(outcome.cause)) {
        const { cause } = outcome;

        if (
          cause instanceof AniListUnavailableError &&
          cause.reason === "server" &&
          (yield* aniListAnswers(token))
        ) {
          // AniList is up, so the 5xx is about this op. Count the attempt:
          // unreported, the op would be retried first on every pass, never
          // block and hold up everything behind it.
          yield* Effect.logError(`[manifold] drain failed:${op.kind}:${cause.message}`);
          results.push({ opId: op.opId, ok: false, error: cause.message });

          if (title !== undefined) {
            waiting.add(title);
          }

          continue;
        }

        // Rejected credentials, an outage or a rate limit say nothing about
        // this op. The API blocks an op after five reported failures, so
        // report nothing for it or the ops after it and end the pass.
        yield* Effect.logError(`[manifold] drain stopped:${op.kind}:${cause.message}`);
        stoppedBy = cause;
        break;
      }

      if (!outcome.ok) {
        const error = errorMessage(outcome.cause);
        yield* Effect.logError(`[manifold] drain failed:${op.kind}:${error}`);
        results.push({ opId: op.opId, ok: false, error });
        continue;
      }

      results.push({
        opId: op.opId,
        ok: true,
        ...(outcome.mediaListEntryId !== undefined && {
          mediaListEntryId: outcome.mediaListEntryId,
        }),
      });
      const drainedAnilistId = op.payload["anilistId"];
      yield* Effect.logInfo(
        `[manifold] drained op:${op.kind}:${isString(drainedAnilistId) ? drainedAnilistId : ""}`,
      );
    }

    if (results.length > 0) {
      yield* fromPromise(() => api.completeOps(results)).pipe(
        Effect.catch((cause) =>
          // Completion reporting is best-effort; failed ops simply retry later.
          Effect.logError(`[manifold] drain completion report failed:${errorMessage(cause)}`).pipe(
            Effect.asVoid,
          ),
        ),
      );
    }

    if (stoppedBy !== undefined) {
      // Fail the pass so the next piggyback retries after the short interval.
      return yield* stoppedBy;
    }
  });

/**
 * Executes every pending anilist:* op, then reports per-op outcomes back to
 * the personal API. Returns silently when there is nothing to do or AniList
 * is not connected — draining is opportunistic, never a hard dependency.
 * Rejects, after acknowledging the ops already done, when AniList rejected the
 * token, was unreachable or kept rate limiting: the remaining ops stay pending.
 */
export const drainAniListOps = (): Promise<void> => Effect.runPromise(drainAniListOpsEffect());

/** Throttled, fire-and-forget drain suitable for piggybacking on any request. */
export const maybeDrainAniListOps = (): void => {
  const nowMs = Date.now();

  if (nowMs - lastDrainAt < DRAIN_MIN_INTERVAL_MS) {
    return;
  }

  if (nowMs - lastAttemptAt < DRAIN_RETRY_INTERVAL_MS) {
    return;
  }

  if (!aniListToken()) {
    return;
  }

  if (drainInFlight) {
    return;
  }

  lastAttemptAt = nowMs;
  drainInFlight = drainAniListOps()
    .then(() => {
      lastDrainAt = Date.now();
    })
    .catch((cause) => {
      console.error(`[manifold] op drain error:${errorMessage(cause)}`);
    })
    .finally(() => {
      drainInFlight = undefined;
    });
};
