import { Effect } from "effect";
import type { SyncHost } from "./host";
import { now, SYNC_MAX_ATTEMPTS, SYNC_DUE_AT_SQL } from "./constants";
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
          `SELECT MIN(${SYNC_DUE_AT_SQL}) AS due_at FROM sync_ops
           WHERE state = 'pending' AND target IN ('mangadex', 'mal')`,
        )
        .toArray()[0]?.due_at ?? null;

    // NULL when no shelf row is pending.
    const shelfDueAt =
      host.ctx.storage.sql
        .exec<{ due_at: number | null }>(
          `SELECT MIN(${SYNC_DUE_AT_SQL}) AS due_at FROM md_status_queue
           WHERE attempts < ${SYNC_MAX_ATTEMPTS}`,
        )
        .toArray()[0]?.due_at ?? null;

    if (opsDueAt === null && shelfDueAt === null) {
      return;
    }

    // The alarm waits for the first op or shelf row whose retry delay has passed.
    const dueAt = Math.min(opsDueAt ?? Infinity, shelfDueAt ?? Infinity);
    const scheduledAt = Math.max(now() + Math.max(0, delayMs), dueAt);
    const currentAlarm = yield* fromPromise(() => host.ctx.storage.getAlarm());

    if (currentAlarm === null || currentAlarm <= now() || currentAlarm > scheduledAt) {
      yield* fromPromise(() => host.ctx.storage.setAlarm(scheduledAt));
    }
  });

export const scheduleSync = (host: SyncHost, delayMs = 0): Promise<void> =>
  Effect.runPromise(scheduleSyncEffect(host, delayMs));
