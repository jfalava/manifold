import type { SyncHost } from "./host";
import { now } from "./constants";

export function migrate(host: SyncHost): void {
  host.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS canonical_entries (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // Big-bang registry: entries are provider-neutral rows keyed by a minted
  // UUID; the provider columns record the minting source only.
  try {
    host.ctx.storage.sql.exec("ALTER TABLE canonical_entries ADD COLUMN tombstoned_at INTEGER");
  } catch {
    // Column already exists.
  }
  try {
    host.ctx.storage.sql.exec("ALTER TABLE canonical_entries DROP COLUMN chapter_source");
  } catch {
    // Column is absent on source-free registries.
  }
  try {
    host.ctx.storage.sql.exec("ALTER TABLE oauth_sessions ADD COLUMN return_path TEXT");
  } catch {
    // Column already exists.
  }
  host.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS provider_links (
      entry_id TEXT NOT NULL REFERENCES canonical_entries(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entry_id, provider)
    );

    CREATE INDEX IF NOT EXISTS provider_links_external
      ON provider_links (provider, external_id);

    CREATE TABLE IF NOT EXISTS read_events (
      event_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES canonical_entries(id) ON DELETE CASCADE,
      chapter_key TEXT NOT NULL,
      read_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS progress_state (
      entry_id TEXT PRIMARY KEY REFERENCES canonical_entries(id) ON DELETE CASCADE,
      chapter_key TEXT NOT NULL,
      chapter_number REAL,
      volume_number REAL,
      provider TEXT,
      source_chapter_id TEXT,
      read_at INTEGER NOT NULL,
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS md_status_queue (
      entry_id TEXT PRIMARY KEY REFERENCES canonical_entries(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS md_feed_stats (
      manga_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      computed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_sessions (
      provider TEXT NOT NULL,
      state TEXT NOT NULL,
      code_verifier TEXT,
      redirect_uri TEXT NOT NULL,
      return_path TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, state)
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_type TEXT NOT NULL,
      expires_at INTEGER,
      scope TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_state (
      entry_id TEXT PRIMARY KEY REFERENCES canonical_entries(id) ON DELETE CASCADE,
      status TEXT,
      score REAL,
      notes TEXT,
      started_at TEXT,
      completed_at TEXT,
      volume_progress REAL,
      media_list_entry_id INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'device',
      payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sync_ops_drain
      ON sync_ops (target, state, id);

    CREATE TABLE IF NOT EXISTS list_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL REFERENCES canonical_entries(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS list_events_entry
      ON list_events (entry_id, id);

    DROP TABLE IF EXISTS update_probe_failures;
  `);
  try {
    host.ctx.storage.sql.exec("ALTER TABLE md_status_queue ADD COLUMN last_error TEXT");
  } catch {
    // Column already exists.
  }
  migrateLegacyOutbox(host);
}

export function migrateLegacyOutbox(host: SyncHost): void {
  const legacy = host.ctx.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'",
    )
    .toArray()[0];
  if (!legacy) {
    return;
  }
  const timestamp = now();
  host.ctx.storage.sql.exec(
    `INSERT OR IGNORE INTO sync_ops
       (op_id, target, kind, origin, payload, state, attempts, last_error, created_at, updated_at)
     SELECT event_id, 'mangadex', 'mangadex.read', 'device',
            payload, status, attempts, NULL, created_at, ?
     FROM sync_outbox`,
    timestamp,
  );
  host.ctx.storage.sql.exec("DROP TABLE sync_outbox");
}
