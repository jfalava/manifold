/** @effect-diagnostics asyncFunction:off */
import { Effect, Schema } from "effect";
import { scheduleSync } from "./schedule";
import type { SyncHost } from "./host";
import { now } from "./constants";
import { fromPromise } from "./from-promise";
import { readSecret } from "../read-secret";
import type { RegistryBackupMetadata } from "../domain";
import {
  type EntryRow,
  type ListEventRow,
  type ListStateRow,
  type OAuthTokenRow,
  type OpRow,
  type ProgressRow,
  type ProviderRow,
} from "../sync-rows";
import {
  backupKey,
  isRegistryBackupKey,
  REGISTRY_BACKUP_PREFIX,
  REGISTRY_BACKUP_TABLE_COLUMNS,
  REGISTRY_BACKUP_TABLE_NAMES,
  MAX_REGISTRY_BACKUP_BYTES,
  readBackupBody,
  sha256,
  toBackupRows,
  type RegistryBackup,
} from "../registry-backup";

const JsonString = Schema.fromJsonString(Schema.Unknown);

const backupRegistryEffect = (host: SyncHost) =>
  Effect.gen(function* () {
    const bucket = host.env.REGISTRY_BACKUPS;
    if (!bucket) {
      throw new Error("Registry backup bucket is not configured");
    }
    const backup = yield* fromPromise(() => snapshotRegistry(host));

    const key = backupKey(backup.createdAt);
    const body = yield* Schema.encodeEffect(JsonString)(backup);
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_REGISTRY_BACKUP_BYTES) {
      throw new Error("Registry backup exceeds the 16 MiB recovery limit");
    }
    const digest = yield* fromPromise(() => sha256(body));
    const object = yield* fromPromise(() =>
      bucket.put(key, body, {
        httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
        customMetadata: {
          sha256: digest,
          createdAt: String(backup.createdAt),
          databaseSize: String(backup.databaseSize),
          entryCount: String(backup.tables.canonical_entries.length),
          bookmark: backup.bookmark,
        },
      }),
    );

    return backupMetadata(host, backup, key, object.uploaded.getTime(), size);
  });

export const backupRegistry = (host: SyncHost): Promise<RegistryBackupMetadata> =>
  Effect.runPromise(backupRegistryEffect(host));

const listBackupsEffect = (host: SyncHost) =>
  Effect.gen(function* () {
    const bucket = host.env.REGISTRY_BACKUPS;
    if (!bucket) {
      throw new Error("Registry backup bucket is not configured");
    }

    const backups: RegistryBackupMetadata[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* fromPromise(() =>
        bucket.list({
          prefix: REGISTRY_BACKUP_PREFIX,
          limit: 1000,
          ...(cursor !== undefined && { cursor }),
          include: ["customMetadata"],
        }),
      );
      for (const object of page.objects) {
        const metadata = object.customMetadata;
        const createdAt = Number(metadata?.createdAt);
        const databaseSize = Number(metadata?.databaseSize);
        const entryCount = Number(metadata?.entryCount);
        const bookmark = metadata?.bookmark;
        if (
          !isRegistryBackupKey(object.key) ||
          !Number.isFinite(createdAt) ||
          !Number.isFinite(databaseSize) ||
          !Number.isFinite(entryCount) ||
          !bookmark
        ) {
          continue;
        }
        backups.push({
          key: object.key,
          createdAt,
          uploadedAt: object.uploaded.getTime(),
          size: object.size,
          databaseSize,
          entryCount,
          bookmark,
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);

    return backups.sort((left, right) => right.createdAt - left.createdAt);
  });

export const listBackups = (host: SyncHost): Promise<readonly RegistryBackupMetadata[]> =>
  Effect.runPromise(listBackupsEffect(host));

const restoreBackupEffect = (host: SyncHost, key: string) =>
  Effect.gen(function* () {
    if (!isRegistryBackupKey(key)) {
      throw new Error("Invalid registry backup key");
    }
    const bucket = host.env.REGISTRY_BACKUPS;
    if (!bucket) {
      throw new Error("Registry backup bucket is not configured");
    }

    // Download and validate before entering the synchronous transaction.
    const object = yield* fromPromise(() => bucket.get(key));
    if (!object) {
      throw new Error(`Registry backup not found: ${key}`);
    }
    const backup = yield* fromPromise(() =>
      readBackupBody(object.body, object.customMetadata?.sha256 ?? ""),
    );
    yield* fromPromise(() => validateBackupKey(host, backup));
    // Preserve the state being replaced, including when the wrong backup was chosen.
    yield* fromPromise(() => backupRegistry(host));
    applyRegistryBackup(host, backup);
    return backupMetadata(host, backup, key, object.uploaded.getTime(), object.size);
  });

export const restoreBackup = (host: SyncHost, key: string): Promise<RegistryBackupMetadata> =>
  Effect.runPromise(restoreBackupEffect(host, key));

const resumeRegistrySyncEffect = (host: SyncHost) =>
  Effect.gen(function* () {
    host.ctx.storage.kv.delete("registry_sync_paused");
    yield* fromPromise(() => scheduleSync(host));
  });

export const resumeRegistrySync = (host: SyncHost): Promise<void> =>
  Effect.runPromise(resumeRegistrySyncEffect(host));

const validateBackupKeyEffect = (host: SyncHost, backup: RegistryBackup) =>
  Effect.gen(function* () {
    const secret = yield* fromPromise(() =>
      readSecret(
        host.env.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET,
        "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET",
      ),
    );
    const fingerprint = yield* fromPromise(() => sha256(secret));
    if (fingerprint !== backup.tokenKeyHash) {
      throw new Error("Restore requires the original MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET");
    }
  });

export const validateBackupKey = (host: SyncHost, backup: RegistryBackup): Promise<void> =>
  Effect.runPromise(validateBackupKeyEffect(host, backup));

export function applyRegistryBackup(host: SyncHost, backup: RegistryBackup): void {
  restoreRegistry(host, backup);
  host.mdLibraryCache = undefined;
}

const snapshotRegistryEffect = (host: SyncHost) =>
  Effect.gen(function* () {
    const secret = yield* fromPromise(() =>
      readSecret(
        host.env.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET,
        "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET",
      ),
    );
    const tokenKeyHash = yield* fromPromise(() => sha256(secret));
    return yield* fromPromise(() =>
      host.ctx.blockConcurrencyWhile(async () => {
        const createdAt = now();
        const bookmark = await host.ctx.storage.getCurrentBookmark();
        const tables: RegistryBackup["tables"] = {
          canonical_entries: toBackupRows(
            host.ctx.storage.sql
              .exec<EntryRow>(
                "SELECT id, provider, provider_id, title, created_at, updated_at, tombstoned_at FROM canonical_entries",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.canonical_entries,
          ),
          provider_links: toBackupRows(
            host.ctx.storage.sql
              .exec<ProviderRow>(
                "SELECT entry_id, provider, external_id, title, updated_at FROM provider_links",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.provider_links,
          ),
          read_events: toBackupRows(
            host.ctx.storage.sql
              .exec<{ event_id: string; entry_id: string; chapter_key: string; read_at: number }>(
                "SELECT event_id, entry_id, chapter_key, read_at FROM read_events",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.read_events,
          ),
          progress_state: toBackupRows(
            host.ctx.storage.sql
              .exec<ProgressRow>(
                "SELECT entry_id, chapter_key, chapter_number, volume_number, provider, source_chapter_id, read_at, version FROM progress_state",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.progress_state,
          ),
          md_status_queue: toBackupRows(
            host.ctx.storage.sql
              .exec<{
                entry_id: string;
                created_at: number;
                attempts: number;
                last_error: string | null;
              }>("SELECT entry_id, created_at, attempts, last_error FROM md_status_queue")
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.md_status_queue,
          ),
          md_feed_stats: toBackupRows(
            host.ctx.storage.sql
              .exec<{ manga_id: string; payload: string; computed_at: number }>(
                "SELECT manga_id, payload, computed_at FROM md_feed_stats",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.md_feed_stats,
          ),
          oauth_tokens: toBackupRows(
            host.ctx.storage.sql
              .exec<OAuthTokenRow>(
                "SELECT provider, access_token, refresh_token, token_type, expires_at, scope, updated_at FROM oauth_tokens",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.oauth_tokens,
          ),
          list_state: toBackupRows(
            host.ctx.storage.sql
              .exec<ListStateRow>(
                "SELECT entry_id, status, score, notes, started_at, completed_at, volume_progress, media_list_entry_id, updated_at FROM list_state",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.list_state,
          ),
          sync_ops: toBackupRows(
            host.ctx.storage.sql
              .exec<OpRow>(
                "SELECT id, op_id, target, kind, origin, payload, state, attempts, last_error, created_at, updated_at FROM sync_ops",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.sync_ops,
          ),
          list_events: toBackupRows(
            host.ctx.storage.sql
              .exec<ListEventRow>(
                "SELECT id, entry_id, kind, origin, detail, created_at FROM list_events",
              )
              .toArray(),
            REGISTRY_BACKUP_TABLE_COLUMNS.list_events,
          ),
        };
        return {
          version: 1 as const,
          kind: "manifold-sync" as const,
          createdAt,
          bookmark,
          databaseSize: host.ctx.storage.sql.databaseSize,
          tokenKeyHash,
          tables,
        };
      }),
    );
  });

export const snapshotRegistry = (host: SyncHost): Promise<RegistryBackup> =>
  Effect.runPromise(snapshotRegistryEffect(host));

export function restoreRegistry(host: SyncHost, backup: RegistryBackup): void {
  host.ctx.storage.transactionSync(() => {
    host.ctx.storage.kv.put("registry_sync_paused", true);
    host.ctx.storage.sql.exec("DELETE FROM oauth_sessions");
    for (const table of [
      "md_status_queue",
      "progress_state",
      "read_events",
      "list_state",
      "list_events",
      "provider_links",
      "canonical_entries",
      "md_feed_stats",
      "oauth_tokens",
      "sync_ops",
    ]) {
      host.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    host.ctx.storage.sql.exec(
      "DELETE FROM sqlite_sequence WHERE name IN ('sync_ops', 'list_events')",
    );

    for (const table of REGISTRY_BACKUP_TABLE_NAMES) {
      const columns = REGISTRY_BACKUP_TABLE_COLUMNS[table];
      const placeholders = columns.map(() => "?").join(", ");
      for (const row of backup.tables[table]) {
        host.ctx.storage.sql.exec(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
          ...columns.map((column) => row[column]),
        );
      }
    }
  });
}

export function backupMetadata(
  host: SyncHost,
  backup: RegistryBackup,
  key: string,
  uploadedAt: number,
  size: number,
): RegistryBackupMetadata {
  return {
    key,
    createdAt: backup.createdAt,
    uploadedAt,
    size,
    databaseSize: backup.databaseSize,
    entryCount: backup.tables.canonical_entries.length,
    bookmark: backup.bookmark,
  };
}
