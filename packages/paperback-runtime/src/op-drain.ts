/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics unknownInEffectCatch:off */
import { isFiniteNumber, isString } from "@manifold/json";
import { Effect } from "effect";
import { fromPromise } from "./from-promise.js";
import { ANILIST_SESSION_KEY, ANILIST_VIEWER_ID_KEY } from "./anilist-types.js";
import { errorMessage } from "./errors.js";
import {
  deleteAniListEntry,
  fetchAniListMediaListEntryIds,
  saveAniListFields,
  saveAniListProgress,
  saveAniListStatus,
} from "./anilist-graphql.js";
import type { PendingSyncOp } from "./api.js";
import { parsePendingAniListOp } from "./op-payload.js";
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
): Effect.Effect<number | undefined, unknown> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parsePendingAniListOp(op),
      catch: (c) => c,
    });

    switch (parsed.kind) {
      case "anilist.status": {
        const result = yield* fromPromise(() =>
          saveAniListStatus(token, parsed.anilistId, parsed.status),
        );
        return result.mediaListEntryId;
      }
      case "anilist.progress": {
        yield* fromPromise(() => saveAniListProgress(token, parsed.anilistId, parsed.progress));
        return undefined;
      }
      case "anilist.fields": {
        yield* fromPromise(() => saveAniListFields(token, parsed.anilistId, parsed.change));
        return parsed.mediaListEntryId;
      }
      case "anilist.delete": {
        let listEntryId = parsed.mediaListEntryId;
        if (listEntryId === undefined && mediaListEntryIds) {
          listEntryId = mediaListEntryIds[parsed.anilistId];
        }
        if (listEntryId === undefined) {
          return yield* Effect.fail(
            new Error(`op ${parsed.opId}: no mediaListEntryId for ${parsed.anilistId}`),
          );
        }
        yield* fromPromise(() => deleteAniListEntry(token, listEntryId));
        return listEntryId;
      }
    }
  });

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

    const needsListEntryIds = ops.some(
      (op) => op.kind === "anilist.delete" && op.payload["mediaListEntryId"] === undefined,
    );
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
    for (const op of ops) {
      const outcome = yield* executeOp(token, op, mediaListEntryIds).pipe(
        Effect.map((mediaListEntryId) => ({ ok: true as const, mediaListEntryId })),
        Effect.catch((cause: unknown) =>
          Effect.succeed({ ok: false as const, error: errorMessage(cause) }),
        ),
      );
      if (!outcome.ok) {
        console.error(`[manifold] drain failed:${op.kind}:${outcome.error}`);
        results.push({ opId: op.opId, ok: false, error: outcome.error });
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
      console.log(
        `[manifold] drained op:${op.kind}:${isString(drainedAnilistId) ? drainedAnilistId : ""}`,
      );
    }

    yield* fromPromise(() => api.completeOps(results)).pipe(
      Effect.catch((cause) => {
        // Completion reporting is best-effort; failed ops simply retry later.
        console.error(`[manifold] drain completion report failed:${errorMessage(cause)}`);
        return Effect.void;
      }),
    );
  });

/**
 * Executes every pending anilist:* op, then reports per-op outcomes back to
 * the personal API. Returns silently when there is nothing to do or AniList
 * is not connected — draining is opportunistic, never a hard dependency.
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
