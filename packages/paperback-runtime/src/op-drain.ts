import { isFiniteNumber, isString } from "@manifold/json";
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
const DRAIN_BATCH_LIMIT = 25;

let lastDrainAt = 0;
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

const executeOp = async (
  token: string,
  op: PendingSyncOp,
  mediaListEntryIds: Record<string, number> | undefined,
): Promise<number | undefined> => {
  const parsed = parsePendingAniListOp(op);

  switch (parsed.kind) {
    case "anilist.status": {
      const result = await saveAniListStatus(token, parsed.anilistId, parsed.status);
      return result.mediaListEntryId;
    }
    case "anilist.progress": {
      await saveAniListProgress(token, parsed.anilistId, parsed.progress);
      return undefined;
    }
    case "anilist.fields": {
      await saveAniListFields(token, parsed.anilistId, parsed.change);
      return parsed.mediaListEntryId;
    }
    case "anilist.delete": {
      let listEntryId = parsed.mediaListEntryId;
      if (listEntryId === undefined && mediaListEntryIds) {
        listEntryId = mediaListEntryIds[parsed.anilistId];
      }
      if (listEntryId === undefined) {
        throw new Error(`op ${parsed.opId}: no mediaListEntryId for ${parsed.anilistId}`);
      }
      await deleteAniListEntry(token, listEntryId);
      return listEntryId;
    }
  }
};

/**
 * Executes every pending anilist:* op, then reports per-op outcomes back to
 * the personal API. Returns silently when there is nothing to do or AniList
 * is not connected — draining is opportunistic, never a hard dependency.
 */
export const drainAniListOps = async (): Promise<void> => {
  const token = aniListToken();
  if (!token) {
    return;
  }
  const api = configuredPersonalApi();
  const ops = await api.pendingAniListOps(DRAIN_BATCH_LIMIT);
  if (ops.length === 0) {
    return;
  }

  const needsListEntryIds = ops.some(
    (op) => op.kind === "anilist.delete" && op.payload["mediaListEntryId"] === undefined,
  );
  const userId = aniListUserId();
  const mediaListEntryIds =
    needsListEntryIds && userId !== undefined
      ? await fetchAniListMediaListEntryIds(token, userId)
      : undefined;

  const results: {
    opId: string;
    ok: boolean;
    error?: string;
    mediaListEntryId?: number;
  }[] = [];
  for (const op of ops) {
    let mediaListEntryId: number | undefined;
    try {
      mediaListEntryId = await executeOp(token, op, mediaListEntryIds);
    } catch (cause) {
      const message = errorMessage(cause);
      console.error(`[manifold] drain failed:${op.kind}:${message}`);
      results.push({ opId: op.opId, ok: false, error: message });
      continue;
    }
    results.push({
      opId: op.opId,
      ok: true,
      ...(mediaListEntryId !== undefined && { mediaListEntryId }),
    });
    const drainedAnilistId = op.payload["anilistId"];
    console.log(
      `[manifold] drained op:${op.kind}:${isString(drainedAnilistId) ? drainedAnilistId : ""}`,
    );
  }

  try {
    await api.completeOps(results);
  } catch (error) {
    // Completion reporting is best-effort; failed ops simply retry later.
    console.error(`[manifold] drain completion report failed:${errorMessage(error)}`);
  }
};

/** Throttled, fire-and-forget drain suitable for piggybacking on any request. */
export const maybeDrainAniListOps = (): void => {
  const nowMs = Date.now();
  if (nowMs - lastDrainAt < DRAIN_MIN_INTERVAL_MS) {
    return;
  }
  if (!aniListToken()) {
    return;
  }
  lastDrainAt = nowMs;
  if (drainInFlight) {
    return;
  }
  drainInFlight = drainAniListOps()
    .catch((cause) => {
      console.error(`[manifold] op drain error:${errorMessage(cause)}`);
    })
    .finally(() => {
      drainInFlight = undefined;
    });
};
