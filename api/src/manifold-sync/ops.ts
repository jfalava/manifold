import { Effect } from "effect";
import { scheduleSync } from "./schedule";
import { fromPromise } from "./from-promise";
import { readOps } from "./sql-helpers";
import type { SyncHost } from "./host";
import { MAX_ERROR_LENGTH, now, SYNC_MAX_ATTEMPTS } from "./constants";
import { isJsonObject, stringField } from "@manifold/json";
import { parseJsonText } from "@manifold/json/text";
import type { CompleteOpsInput, OpState, SyncOp, OpsSummary } from "../domain";
import { type OpRow, toOp } from "../sync-rows";

export function listPendingSync(host: SyncHost): readonly SyncOp[] {
  return readOps(host, "mangadex", "pending");
}

const retryFailedSyncEffect = (host: SyncHost) =>
  Effect.gen(function* () {
    const timestamp = now();

    const ops = host.ctx.storage.sql
      .exec(
        `UPDATE sync_ops SET state = 'pending', attempts = 0, updated_at = ?
     WHERE target = 'mangadex' AND (state IN ('failed', 'blocked') OR attempts > 0)
     RETURNING id`,
        timestamp,
      )
      .toArray().length;

    // Shelf rows alongside sync_ops, so one manual retry covers both. Rows
    // waiting out a backoff count too: retrying now is what was asked for.
    const shelf = host.ctx.storage.sql
      .exec(
        `UPDATE md_status_queue SET attempts = 0, last_error = NULL
     WHERE attempts > 0
     RETURNING entry_id`,
      )
      .toArray().length;

    yield* fromPromise(() => scheduleSync(host));

    // Rows this call made due, not the whole pending backlog.
    return { retried: ops + shelf };
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
        const parsed = parseJsonText(row.payload);
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
        (
          result.error ?? `${row.kind} failed on the device drain, which reported no error message`
        ).slice(0, MAX_ERROR_LENGTH),
        timestamp,
        row.id,
      );
    }

    updated += 1;
  }

  return { updated };
}

const retryOpEffect = (host: SyncHost, opId: string) =>
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

export function listOps(host: SyncHost, state?: string, target?: string, limit = 200) {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (state === "error") {
    // Every op that has failed at least once: retrying (pending with an
    // error), failed, or blocked.
    clauses.push("(o.last_error IS NOT NULL OR o.state IN ('failed', 'blocked'))");
  } else if (state && ["pending", "completed", "failed", "blocked"].includes(state)) {
    clauses.push("o.state = ?");
    params.push(state);
  }

  if (target && ["mangadex", "anilist", "mal"].includes(target)) {
    clauses.push("o.target = ?");
    params.push(target);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const total =
    host.ctx.storage.sql
      .exec<{ total: number }>(`SELECT COUNT(*) AS total FROM sync_ops o ${where}`, ...params)
      .toArray()[0]?.total ?? 0;

  const rows = host.ctx.storage.sql
    .exec<OpRow & { entry_title: string | null }>(
      `SELECT o.*, ce.title AS entry_title
       FROM sync_ops o
       LEFT JOIN canonical_entries ce
         ON ce.id = CASE WHEN json_valid(o.payload) THEN json_extract(o.payload, '$.entryId') END
       ${where}
       ORDER BY o.id DESC LIMIT ?`,
      ...params,
      Math.min(500, Math.max(1, limit)),
    )
    .toArray();

  return {
    ops: rows.map((row) => ({
      ...toOp(row),
      ...(row.entry_title !== null && { entryTitle: row.entry_title }),
    })),
    total,
  };
}

export function opsSummary(host: SyncHost): OpsSummary {
  // Aggregated in SQL over every op: a window of the newest rows would hide
  // exactly the oldest pending and blocked ops this summary exists to surface.
  const counts = host.ctx.storage.sql
    .exec<{ state: string; count: number; oldest: number }>(
      `SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest
       FROM sync_ops
       GROUP BY state`,
    )
    .toArray();

  const lastFailed = host.ctx.storage.sql
    .exec<{ last_error: string }>(
      `SELECT last_error
       FROM sync_ops
       WHERE state IN ('failed', 'blocked') AND last_error IS NOT NULL
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .toArray()[0];

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
    total: counts.reduce((sum, row) => sum + row.count, 0),
    states: Object.fromEntries(counts.map((row) => [row.state, row.count])),
    oldestPendingAt: counts.find((row) => row.state === "pending")?.oldest ?? null,
    lastFailedError: lastFailed?.last_error ?? null,
    shelfPending,
    shelfBlocked,
    shelfLastBlockedError,
  };
}

const backfillMangaDexShelfEffect = (host: SyncHost) =>
  Effect.gen(function* () {
    // Counted from RETURNING: rowsWritten also counts the primary-key index
    // row, which doubled the reported number.
    const enqueued = host.ctx.storage.sql
      .exec(
        `INSERT INTO md_status_queue (entry_id, created_at, attempts)
       SELECT ps.entry_id, ?, 0
       FROM progress_state ps
       JOIN provider_links pl
         ON pl.entry_id = ps.entry_id AND pl.provider = 'mangadex'
       LEFT JOIN md_status_queue q ON q.entry_id = ps.entry_id
       WHERE q.entry_id IS NULL
       ON CONFLICT DO NOTHING
       RETURNING entry_id`,
        now(),
      )
      .toArray().length;

    yield* fromPromise(() => scheduleSync(host));

    return { enqueued };
  });

export const backfillMangaDexShelf = (host: SyncHost): Promise<{ enqueued: number }> =>
  Effect.runPromise(backfillMangaDexShelfEffect(host));
