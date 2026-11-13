import { Effect } from "effect";
import type { SyncHost } from "./host";
import { now, SYNC_MAX_ATTEMPTS, SYNC_OP_DUE_AT_SQL } from "./constants";
import { fromPromise } from "./from-promise";

const scheduleSyncEffect = (host: SyncHost, delayMs = 0) =>
  Effect.gen(function* () {
    if (host.ctx.storage.kv.get("registry_sync_paused")) {
      return;
    }

    // NULL when no Worker-drained op is pending.
    const opsDueAt =
      host.ctx.storage.sql
        .exec<{ due_at: number | null }>(
          `SELECT MIN(${SYNC_OP_DUE_AT_SQL}) AS due_at FROM sync_ops
           WHERE state = 'pending' AND target IN ('mangadex', 'mal')`,
        )
        .toArray()[0]?.due_at ?? null;

    const shelfPending =
      host.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM md_status_queue WHERE attempts < ${SYNC_MAX_ATTEMPTS}`,
        )
        .toArray()[0]?.count ?? 0;

    if (opsDueAt === null && shelfPending === 0) {
      return;
    }

    // Shelf rows carry no retry time, so they are due at once. Otherwise the
    // alarm waits for the first op whose retry delay has passed.
    const dueAt = shelfPending > 0 || opsDueAt === null ? 0 : opsDueAt;
    const scheduledAt = Math.max(now() + Math.max(0, delayMs), dueAt);
    const currentAlarm = yield* fromPromise(() => host.ctx.storage.getAlarm());

    if (currentAlarm === null || currentAlarm <= now() || currentAlarm > scheduledAt) {
      yield* fromPromise(() => host.ctx.storage.setAlarm(scheduledAt));
    }
  });

export const scheduleSync = (host: SyncHost, delayMs = 0): Promise<void> =>
  Effect.runPromise(scheduleSyncEffect(host, delayMs));
