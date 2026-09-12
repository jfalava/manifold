import { Effect } from "effect";
import { scheduleSync } from "./schedule";
import { fromPromise } from "./from-promise";
import { readOps } from "./sql-helpers";
import type { SyncHost } from "./host";
import { now, SYNC_MAX_ATTEMPTS } from "./constants";
import { isJsonObject, stringField } from "@manifold/json";
import type { CompleteOpsInput, OpState, SyncOp, OpsSummary } from "../domain";
import { type OpRow, toOp } from "../sync-rows";

export function listPendingSync(host: SyncHost): readonly SyncOp[] {
  return readOps(host, "mangadex", "pending");
}

const retryFailedSyncEffect = (host: SyncHost): Effect.Effect<{ retried: number }, unknown> =>
  Effect.gen(function* () {
    const timestamp = now();
    host.ctx.storage.sql.exec(
      `UPDATE sync_ops SET state = 'pending', attempts = 0, updated_at = ?
     WHERE target = 'mangadex' AND state IN ('failed', 'blocked')`,
      timestamp,
    );
    // Re-arm shelf DLQ rows alongside sync_ops so one manual retry covers both.
    host.ctx.storage.sql.exec(
      `UPDATE md_status_queue SET attempts = 0, last_error = NULL
     WHERE attempts >= ${SYNC_MAX_ATTEMPTS}`,
    );
    const pending =
      host.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sync_ops WHERE state = 'pending' AND target = 'mangadex'",
        )
        .toArray()[0]?.count ?? 0;
    const shelfPending =
      host.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM md_status_queue WHERE attempts < ${SYNC_MAX_ATTEMPTS}`,
        )
        .toArray()[0]?.count ?? 0;
    yield* fromPromise(() => scheduleSync(host));
    return { retried: pending + shelfPending };
  });

export const retryFailedSync = (host: SyncHost): Promise<{ retried: number }> =>
  Effect.runPromise(retryFailedSyncEffect(host));

export function pendingAniListOps(host: SyncHost, limit = 25): readonly SyncOp[] {
  return readOps(host, "anilist", "pending", Math.min(100, Math.max(1, limit)));
}

export function completeOps(host: SyncHost, input: CompleteOpsInput) {
  let updated = 0;
  const timestamp = now();
  for (const result of input.results) {
    const row = host.ctx.storage.sql
      .exec<OpRow>("SELECT * FROM sync_ops WHERE op_id = ?", result.opId)
      .toArray()[0];
    if (!row || row.state !== "pending") {
      continue;
    }
    if (result.ok) {
      if (result.mediaListEntryId !== undefined && row.target === "anilist") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload);
        } catch {
          parsed = undefined;
        }
        const entryId = isJsonObject(parsed) ? stringField(parsed, "entryId") : undefined;
        if (entryId) {
          host.ctx.storage.sql.exec(
            "UPDATE list_state SET media_list_entry_id = ? WHERE entry_id = ?",
            result.mediaListEntryId,
            entryId,
          );
        }
      }
      // Successes are not logged: the row is deleted so the outbox only
      // retains actionable (pending/failed/blocked) ops.
      host.ctx.storage.sql.exec("DELETE FROM sync_ops WHERE id = ?", row.id);
    } else {
      const attempts = row.attempts + 1;
      const state: OpState = attempts >= SYNC_MAX_ATTEMPTS ? "blocked" : "pending";
      host.ctx.storage.sql.exec(
        `UPDATE sync_ops SET state = ?, attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        state,
        attempts,
        (result.error ?? "unknown drain failure").slice(0, 500),
        timestamp,
        row.id,
      );
    }
    updated += 1;
  }
  return { updated };
}

const retryOpEffect = (host: SyncHost, opId: string): Effect.Effect<SyncOp | undefined, unknown> =>
  Effect.gen(function* () {
    const timestamp = now();
    host.ctx.storage.sql.exec(
      `UPDATE sync_ops SET state = 'pending', attempts = 0, last_error = NULL, updated_at = ?
     WHERE op_id = ?`,
      timestamp,
      opId,
    );
    const row = host.ctx.storage.sql
      .exec<OpRow>("SELECT * FROM sync_ops WHERE op_id = ?", opId)
      .toArray()[0];
    // Both server-drained targets need an alarm: after retries exhaust, the
    // alarm loop stops scheduling itself, so a manual retry of a blocked
    // mangadex or mal op must re-arm it. Device anilist ops are drained by
    // the device, not by alarms.
    if (row?.target === "mal" || row?.target === "mangadex") {
      yield* fromPromise(() => scheduleSync(host));
    }
    return row ? toOp(row) : undefined;
  });

export const retryOp = (host: SyncHost, opId: string): Promise<SyncOp | undefined> =>
  Effect.runPromise(retryOpEffect(host, opId));

export function listOps(
  host: SyncHost,
  state?: string,
  target?: string,
  limit = 200,
): readonly SyncOp[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (state && ["pending", "completed", "failed", "blocked"].includes(state)) {
    clauses.push("state = ?");
    params.push(state);
  }
  if (target && ["mangadex", "anilist", "mal"].includes(target)) {
    clauses.push("target = ?");
    params.push(target);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(500, Math.max(1, limit)));
  const rows = host.ctx.storage.sql
    .exec<OpRow>(`SELECT * FROM sync_ops ${where} ORDER BY id DESC LIMIT ?`, ...params)
    .toArray();
  return rows.map((row) => toOp(row));
}

export function opsSummary(host: SyncHost, limit = 200): OpsSummary {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = host.ctx.storage.sql
    .exec<{
      state: string;
      created_at: number;
      updated_at: number;
      last_error: string | null;
    }>(
      `SELECT state, created_at, updated_at, last_error
           FROM sync_ops
           ORDER BY id DESC
           LIMIT ?`,
      safeLimit,
    )
    .toArray();
  const states = new Map<string, number>();
  let oldestPendingAt: number | null = null;
  let lastFailedError: string | null = null;
  let lastFailedAt = 0;
  for (const row of rows) {
    states.set(row.state, (states.get(row.state) ?? 0) + 1);
    if (row.state === "pending" && (oldestPendingAt === null || row.created_at < oldestPendingAt)) {
      oldestPendingAt = row.created_at;
    }
    if (
      (row.state === "failed" || row.state === "blocked") &&
      row.last_error !== null &&
      row.updated_at > lastFailedAt
    ) {
      lastFailedAt = row.updated_at;
      lastFailedError = row.last_error;
    }
  }
  const shelf = host.ctx.storage.sql
    .exec<{ attempts: number; created_at: number; last_error: string | null }>(
      "SELECT attempts, created_at, last_error FROM md_status_queue",
    )
    .toArray();
  let shelfPending = 0;
  let shelfBlocked = 0;
  let shelfLastBlockedError: string | null = null;
  let shelfLastBlockedAt = 0;
  for (const row of shelf) {
    if (row.attempts >= SYNC_MAX_ATTEMPTS) {
      shelfBlocked += 1;
      if (row.last_error !== null && row.created_at > shelfLastBlockedAt) {
        shelfLastBlockedAt = row.created_at;
        shelfLastBlockedError = row.last_error;
      }
    } else {
      shelfPending += 1;
    }
  }
  return {
    total: rows.length,
    states: Object.fromEntries(states),
    oldestPendingAt,
    lastFailedError,
    shelfPending,
    shelfBlocked,
    shelfLastBlockedError,
  };
}

const backfillMangaDexShelfEffect = (
  host: SyncHost,
): Effect.Effect<{ enqueued: number }, unknown> =>
  Effect.gen(function* () {
    const enqueued =
      host.ctx.storage.sql.exec<{ count: number }>(
        `INSERT INTO md_status_queue (entry_id, created_at, attempts)
       SELECT ps.entry_id, ?, 0
       FROM progress_state ps
       JOIN provider_links pl
         ON pl.entry_id = ps.entry_id AND pl.provider = 'mangadex'
       LEFT JOIN md_status_queue q ON q.entry_id = ps.entry_id
       WHERE q.entry_id IS NULL
       ON CONFLICT DO NOTHING`,
        now(),
      ).rowsWritten ?? 0;
    yield* fromPromise(() => scheduleSync(host));
    return { enqueued };
  });

export const backfillMangaDexShelf = (host: SyncHost): Promise<{ enqueued: number }> =>
  Effect.runPromise(backfillMangaDexShelfEffect(host));
