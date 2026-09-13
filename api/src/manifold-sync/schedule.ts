import { Effect } from "effect";
import type { SyncHost } from "./host";
import { now, SYNC_MAX_ATTEMPTS } from "./constants";
import { fromPromise } from "./from-promise";

const scheduleSyncEffect = (host: SyncHost, delayMs = 0) =>
  Effect.gen(function* () {
    if (host.ctx.storage.kv.get("registry_sync_paused")) {
      return;
    }
    const pending =
      host.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sync_ops WHERE state = 'pending' AND target IN ('mangadex', 'mal')",
        )
        .toArray()[0]?.count ?? 0;
    const shelfPending =
      host.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM md_status_queue WHERE attempts < ${SYNC_MAX_ATTEMPTS}`,
        )
        .toArray()[0]?.count ?? 0;
    if (pending === 0 && shelfPending === 0) {
      return;
    }

    const scheduledAt = now() + Math.max(0, delayMs);
    const currentAlarm = yield* fromPromise(() => host.ctx.storage.getAlarm());
    if (currentAlarm === null || currentAlarm <= now() || currentAlarm > scheduledAt) {
      yield* fromPromise(() => host.ctx.storage.setAlarm(scheduledAt));
    }
  });

export const scheduleSync = (host: SyncHost, delayMs = 0): Promise<void> =>
  Effect.runPromise(scheduleSyncEffect(host, delayMs));
