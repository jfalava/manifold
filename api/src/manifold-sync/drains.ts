import { Effect, Option, Schema } from "effect";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import { createMangaDexClient } from "@manifold/mangadex";
import type { OpState, RegistryEntry } from "../domain";
import { hostLogError } from "../effect-host";
import { MalBackupPayload, resolveMalBackup, writeMalBackupStatus } from "../mal-backup";
import { groupOutboxForDrain } from "../outbox-drain";
import { type OpRow } from "../sync-rows";
import { getAuthAccessToken } from "./auth";
import {
  MD_STATUS_DRAIN_LIMIT,
  now,
  SYNC_DRAIN_LIMIT,
  SYNC_MAX_ATTEMPTS,
  SYNC_RETRY_DELAY_MS,
} from "./constants";
import type { SyncHost } from "./host";
import { getEntry } from "./registry-crud";
import { scheduleSync } from "./schedule";
import { appendEvent, readEntry, readListState } from "./sql-helpers";

/** Promise boundary: rejections become typed failures (not defects). */
const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: action, catch: (cause) => cause });

export const failShelfEntry = (
  host: SyncHost,
  entryId: string,
  attempts: number,
  cause: unknown,
): void => {
  const message = errorMessage(cause).slice(0, 500);
  host.ctx.storage.sql.exec(
    "UPDATE md_status_queue SET attempts = ?, last_error = ? WHERE entry_id = ?",
    attempts,
    message,
    entryId,
  );
  const outcome = attempts >= SYNC_MAX_ATTEMPTS ? "blocked" : "retry";
  hostLogError(
    `[ManifoldSync] MangaDex shelf mirror ${outcome}:${entryId}:attempt=${attempts}:${message}`,
  );
};

export const failOps = (
  host: SyncHost,
  rows: readonly { id: number; attempts: number }[],
  cause: unknown,
): void => {
  for (const row of rows) {
    const attempt = row.attempts + 1;
    const state: OpState = attempt >= SYNC_MAX_ATTEMPTS ? "blocked" : "pending";
    host.ctx.storage.sql.exec(
      `UPDATE sync_ops
       SET state = ?, attempts = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
      state,
      attempt,
      errorMessage(cause).slice(0, 500),
      now(),
      row.id,
    );
    hostLogError(
      `[ManifoldSync] op failed:${row.id}:attempt=${attempt}:` + `${state}:${errorMessage(cause)}`,
    );
  }
};

export const readMalBackupEntry = (host: SyncHost, entryId: string): RegistryEntry | undefined => {
  const active = host.ctx.storage.sql
    .exec<{ id: string }>(
      "SELECT id FROM canonical_entries WHERE id = ? AND tombstoned_at IS NULL",
      entryId,
    )
    .toArray()[0];
  return active ? readEntry(host, entryId, false) : undefined;
};

const drainMalBackupsEffect = (host: SyncHost): Effect.Effect<void> =>
  Effect.gen(function* () {
    const rows = host.ctx.storage.sql
      .exec<OpRow>(
        "SELECT * FROM sync_ops WHERE target = 'mal' AND state = 'pending' ORDER BY id LIMIT 5",
      )
      .toArray();
    for (const row of rows) {
      yield* Effect.gen(function* () {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.payload);
        } catch {
          return yield* Effect.fail(new Error("Invalid mal backup payload"));
        }
        const decodedPayload = Schema.decodeUnknownOption(MalBackupPayload)(parsed);
        if (Option.isNone(decodedPayload)) {
          return yield* Effect.fail(new Error("Invalid mal backup payload"));
        }
        const payload = decodedPayload.value;
        const entry = readMalBackupEntry(host, payload.entryId);
        if (entry && readListState(host, entry.id)?.status) {
          const accessToken = yield* fromPromise(() => getAuthAccessToken(host, "mal"));
          const match = yield* fromPromise(() =>
            resolveMalBackup(host.env, entry, payload.backupIdentity),
          );
          // Network awaits can outlive an update, unlink, or nuke. Re-check
          // ownership and status immediately before applying the projection.
          const current = readMalBackupEntry(host, entry.id);
          const pending = host.ctx.storage.sql
            .exec<OpRow>("SELECT * FROM sync_ops WHERE id = ? AND state = 'pending'", row.id)
            .toArray()[0];
          if (!pending) {
            return;
          }
          const status = readListState(host, entry.id)?.status;
          if (current && status) {
            const existing = current.providers.find((link) => link.provider === "mal");
            if (match.method === "binding" && !existing) {
              return yield* Effect.fail(new Error("MAL backup binding removed during resolution"));
            }
            if (
              current.providers.find((link) => link.provider === "anilist")?.externalId !==
              entry.providers.find((link) => link.provider === "anilist")?.externalId
            ) {
              return yield* Effect.fail(
                new Error("AniList identity changed during MAL resolution"),
              );
            }
            if (existing && existing.externalId !== match.externalId) {
              return yield* Effect.fail(new Error("MAL backup binding changed during resolution"));
            }
            const owner = host.ctx.storage.sql
              .exec<{ entry_id: string }>(
                "SELECT entry_id FROM provider_links WHERE provider = 'mal' AND external_id = ? AND entry_id <> ?",
                match.externalId,
                entry.id,
              )
              .toArray()[0];
            if (owner) {
              return yield* Effect.fail(
                new Error("MAL backup match already belongs to another registry entry"),
              );
            }
            if (!existing) {
              // Unlike manual linkProvider, automatic backups must never steal
              // a binding or change the canonical entry's provider/title.
              host.ctx.storage.sql.exec(
                "INSERT INTO provider_links (entry_id, provider, external_id, title, updated_at) VALUES (?, 'mal', ?, ?, ?)",
                entry.id,
                match.externalId,
                match.title ?? null,
                now(),
              );
              appendEvent(host, entry.id, "mal.backup.bound", "device", {
                externalId: match.externalId,
                method: match.method,
              });
            }
            yield* fromPromise(() => writeMalBackupStatus(match.externalId, status, accessToken));
          }
        }
        host.ctx.storage.sql.exec(
          "DELETE FROM sync_ops WHERE id = ? AND state = 'pending'",
          row.id,
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failOps(host, [row], error);
          }),
        ),
      );
    }
  });

export const drainMalBackups = (host: SyncHost): Promise<void> =>
  Effect.runPromise(drainMalBackupsEffect(host));

const drainMangaDexOutboxEffect = (
  host: SyncHost,
  rows: readonly OpRow[],
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const accessToken = yield* fromPromise(() => getAuthAccessToken(host, "mangadex"));
    const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });

    // One MangaDex round-trip per manga, not per chapter: per-chapter calls
    // kept the DO input gate closed for minutes during mass-read bursts and
    // starved concurrent /read requests until clients dropped the connection.
    const { groups, invalid } = groupOutboxForDrain(
      rows.map((row) => ({ id: row.id, payload: row.payload, attempts: row.attempts })),
    );
    for (const row of invalid) {
      failOps(host, [row], new Error(`Undecodable outbox payload`));
    }

    for (const group of groups) {
      yield* Effect.gen(function* () {
        const entry = yield* fromPromise(() => getEntry(host, group.entryId));
        const mangaDexId = entry?.providers.find(
          (provider) => provider.provider === "mangadex",
        )?.externalId;
        if (!mangaDexId) {
          return yield* Effect.fail(
            new Error(`No MangaDex provider link for entry ${group.entryId}`),
          );
        }
        yield* client.markChaptersRead(mangaDexId, [...group.chapters]);
        for (const row of group.rows) {
          host.ctx.storage.sql.exec(
            "DELETE FROM sync_ops WHERE id = ? AND state = 'pending'",
            row.id,
          );
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failOps(host, group.rows, error);
          }),
        ),
      );
    }
  });

export const drainMangaDexOutbox = (host: SyncHost, rows: readonly OpRow[]): Promise<void> =>
  Effect.runPromise(drainMangaDexOutboxEffect(host, rows));

const drainMangaDexStatusQueueEffect = (host: SyncHost): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Blocked rows (attempts >= max) are retained as the shelf DLQ with
    // last_error; only pending rows drain here. Manual retry re-arms blocked
    // rows via retryFailedSync.
    const pending = host.ctx.storage.sql
      .exec<{ entry_id: string; attempts: number }>(
        `SELECT entry_id, attempts FROM md_status_queue
       WHERE attempts < ${SYNC_MAX_ATTEMPTS}
       ORDER BY created_at ASC
       LIMIT ${MD_STATUS_DRAIN_LIMIT}`,
      )
      .toArray();
    if (pending.length === 0) {
      return;
    }

    yield* Effect.gen(function* () {
      const accessToken = yield* fromPromise(() => getAuthAccessToken(host, "mangadex"));
      const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });
      const statuses = yield* client.readingStatuses();
      const known = new Set(Object.keys(statuses));

      for (const row of pending) {
        yield* Effect.gen(function* () {
          const mdLink = host.ctx.storage.sql
            .exec<{ external_id: string }>(
              "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'mangadex' LIMIT 1",
              row.entry_id,
            )
            .toArray()[0];
          if (!mdLink) {
            // Link disappeared; nothing to mirror.
            host.ctx.storage.sql.exec(
              "DELETE FROM md_status_queue WHERE entry_id = ?",
              row.entry_id,
            );
            return;
          }
          if (!known.has(mdLink.external_id)) {
            yield* client.updateReadingStatus(mdLink.external_id, "reading");
            known.add(mdLink.external_id);
          }
          host.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", row.entry_id);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failShelfEntry(host, row.entry_id, row.attempts + 1, error);
            }),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          // Token refresh or readingStatuses failed: leave the queue intact and
          // let the next alarm retry.
          hostLogError(`[ManifoldSync] MangaDex shelf mirror batch failed: ${errorMessage(error)}`);
        }),
      ),
    );
  });

export const drainMangaDexStatusQueue = (host: SyncHost): Promise<void> =>
  Effect.runPromise(drainMangaDexStatusQueueEffect(host));

const alarmEffect = (host: SyncHost): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (host.ctx.storage.kv.get("registry_sync_paused")) {
      return;
    }
    yield* drainMalBackupsEffect(host);
    const rows = host.ctx.storage.sql
      .exec<OpRow>(
        `SELECT * FROM sync_ops
       WHERE state = 'pending' AND target = 'mangadex'
       ORDER BY id ASC
       LIMIT ${SYNC_DRAIN_LIMIT}`,
      )
      .toArray();

    if (rows.length > 0) {
      yield* drainMangaDexOutboxEffect(host, rows);
    }

    yield* drainMangaDexStatusQueueEffect(host);

    yield* fromPromise(() => scheduleSync(host, SYNC_RETRY_DELAY_MS));
  });

export const alarm = (host: SyncHost): Promise<void> => Effect.runPromise(alarmEffect(host));
