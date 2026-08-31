import {
  ANILIST_SESSION_KEY,
  ANILIST_VIEWER_ID_KEY,
  type AniListReadingStatus,
} from "./anilist-types.js";
import {
  deleteAniListEntry,
  fetchAniListMediaListEntryIds,
  saveAniListFields,
  saveAniListProgress,
  saveAniListStatus,
} from "./anilist-graphql.js";
import type { PendingSyncOp } from "./api.js";
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

interface DrainPayload {
  readonly entryId?: string;
  readonly anilistId?: string;
  readonly mediaListEntryId?: number;
  readonly status?: string | null;
  readonly progress?: number;
  readonly score?: number | null;
  readonly notes?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly volumeProgress?: number | null;
}

const aniListToken = (): string | undefined => {
  // SAFETY: Paperback secure/state store returns string | undefined for this key
  const token = Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : undefined;
};

const aniListUserId = (): number | undefined => {
  // SAFETY: Paperback secure/state store returns string | number | undefined for this key
  const raw = Application.getState(ANILIST_VIEWER_ID_KEY) as string | number | undefined;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const statusOrNull = (value: string | null | undefined): AniListReadingStatus | null | undefined =>
  // SAFETY: value matches AniListReadingStatus at this call site
  value === undefined ? undefined : value === null ? null : (value as AniListReadingStatus);

const executeOp = async (
  token: string,
  op: PendingSyncOp,
  mediaListEntryIds: Record<string, number> | undefined,
): Promise<number | undefined> => {
  // SAFETY: value matches DrainPayload at this call site
  const payload = op.payload as DrainPayload;
  if (!payload.anilistId) {throw new Error(`op ${op.opId} has no anilistId`);}

  switch (op.kind) {
    case "anilist.status": {
      const result = await saveAniListStatus(
        token,
        payload.anilistId,
        statusOrNull(payload.status) ?? null,
      );
      return result.mediaListEntryId;
    }
    case "anilist.progress": {
      await saveAniListProgress(token, payload.anilistId, payload.progress ?? 0);
      return undefined;
    }
    case "anilist.fields": {
      await saveAniListFields(token, payload.anilistId, {
        ...(!(payload.status === undefined) && { status: statusOrNull(payload.status) }),
        ...(!(payload.score === undefined) && { score: payload.score }),
        ...(!(payload.notes === undefined) && { notes: payload.notes }),
        ...(!(payload.startedAt === undefined) && { startedAt: payload.startedAt }),
        ...(!(payload.completedAt === undefined) && { completedAt: payload.completedAt }),
        ...(!(payload.volumeProgress === undefined) && { volumeProgress: payload.volumeProgress }),
      });
      return payload.mediaListEntryId;
    }
    case "anilist.delete": {
      let listEntryId = payload.mediaListEntryId;
      if (listEntryId === undefined && mediaListEntryIds) {
        listEntryId = mediaListEntryIds[payload.anilistId];
      }
      if (listEntryId === undefined) {
        throw new Error(`op ${op.opId}: no mediaListEntryId for ${payload.anilistId}`);
      }
      await deleteAniListEntry(token, listEntryId);
      return listEntryId;
    }
    default:
      throw new Error(`op ${op.opId}: unknown kind ${op.kind}`);
  }
};

/**
 * Executes every pending anilist:* op, then reports per-op outcomes back to
 * the personal API. Returns silently when there is nothing to do or AniList
 * is not connected — draining is opportunistic, never a hard dependency.
 */
export const drainAniListOps = async (): Promise<void> => {
  const token = aniListToken();
  if (!token) {return;}
  const api = configuredPersonalApi();
  const ops = await api.pendingAniListOps(DRAIN_BATCH_LIMIT);
  if (ops.length === 0) {return;}

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
    try {
      const mediaListEntryId = await executeOp(token, op, mediaListEntryIds);
      results.push({ opId: op.opId, ok: true, ...(mediaListEntryId !== undefined && { mediaListEntryId }) });
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[manifold] drain failed:${op.kind}:${message}`);
      results.push({ opId: op.opId, ok: false, error: message });
    }
  }

  try {
    await api.completeOps(results);
  } catch (error) {
    // Completion reporting is best-effort; failed ops simply retry later.
    console.error(
      `[manifold] drain completion report failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/** Throttled, fire-and-forget drain suitable for piggybacking on any request. */
export const maybeDrainAniListOps = (): void => {
  const nowMs = Date.now();
  if (nowMs - lastDrainAt < DRAIN_MIN_INTERVAL_MS) {return;}
  if (!aniListToken()) {return;}
  lastDrainAt = nowMs;
  if (drainInFlight) {return;}
  drainInFlight = drainAniListOps()
    .catch((error) => {
      console.error(
        `[manifold] op drain error:${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      drainInFlight = undefined;
    });
};
