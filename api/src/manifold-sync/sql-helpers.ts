import type { SyncHost } from "./host";
import { now, SYNC_DRAIN_LIMIT } from "./constants";
import { type JsonObject } from "@manifold/json";
import type {
  RegistryEntry,
  ListState,
  OpKind,
  OpOrigin,
  OpState,
  OpTarget,
  ReadingProgress,
  SyncOp,
} from "../domain";
import {
  type EntryRow,
  type ListStateRow,
  type OpRow,
  type ProgressRow,
  type ProviderRow,
  toListState,
  toOp,
  toProgress,
  toRegistryEntry,
} from "../sync-rows";

export function requireEntry(host: SyncHost, entryId: string): void {
  if (!readEntry(host, entryId, false)) {
    throw new Error(`Canonical entry not found: ${entryId}`);
  }
}

export function enqueueOp(
  host: SyncHost,
  op: {
    opId: string;
    target: OpTarget;
    kind: OpKind;
    origin: OpOrigin;
    payload: JsonObject;
  },
): void {
  const timestamp = now();
  host.ctx.storage.sql.exec(
    `INSERT INTO sync_ops
       (op_id, target, kind, origin, payload, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
     ON CONFLICT(op_id) DO NOTHING`,
    op.opId,
    op.target,
    op.kind,
    op.origin,
    JSON.stringify(op.payload),
    timestamp,
    timestamp,
  );
}

export function readOps(
  host: SyncHost,
  target: OpTarget,
  state?: OpState,
  limit = SYNC_DRAIN_LIMIT,
): readonly SyncOp[] {
  const rows = (
    state
      ? host.ctx.storage.sql
          .exec<OpRow>(
            `SELECT * FROM sync_ops WHERE target = ? AND state = ? ORDER BY id ASC LIMIT ?`,
            target,
            state,
            limit,
          )
          .toArray()
      : host.ctx.storage.sql
          .exec<OpRow>(
            `SELECT * FROM sync_ops WHERE target = ? ORDER BY id ASC LIMIT ?`,
            target,
            limit,
          )
          .toArray()
  ).map((row) => toOp(row));
  return rows;
}

export function readListState(host: SyncHost, entryId: string): ListState | undefined {
  const row = host.ctx.storage.sql
    .exec<ListStateRow>("SELECT * FROM list_state WHERE entry_id = ?", entryId)
    .toArray()[0];
  return row ? toListState(row) : undefined;
}

export function anilistLinkOf(host: SyncHost, entryId: string): string | undefined {
  return (
    host.ctx.storage.sql
      .exec<{ external_id: string }>(
        "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'anilist'",
        entryId,
      )
      .toArray()[0]?.external_id ?? undefined
  );
}

export function appendEvent(
  host: SyncHost,
  entryId: string,
  kind: string,
  origin: OpOrigin,
  detail?: JsonObject,
): void {
  host.ctx.storage.sql.exec(
    `INSERT INTO list_events (entry_id, kind, origin, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    entryId,
    kind,
    origin,
    detail === undefined ? null : JSON.stringify(detail),
    now(),
  );
}

export function readEntry(
  host: SyncHost,
  entryId: string,
  required = true,
): RegistryEntry | undefined {
  const row = host.ctx.storage.sql
    .exec<EntryRow>("SELECT * FROM canonical_entries WHERE id = ?", entryId)
    .toArray()[0];
  if (!row) {
    if (required) {
      throw new Error(`Canonical entry not found: ${entryId}`);
    }
    return undefined;
  }

  const providerRows = host.ctx.storage.sql
    .exec<ProviderRow>(
      "SELECT provider, external_id, title, updated_at FROM provider_links WHERE entry_id = ? ORDER BY provider",
      entryId,
    )
    .toArray();

  return toRegistryEntry(row, providerRows);
}

export function getProgressSync(host: SyncHost, entryId: string): ReadingProgress | undefined {
  const row = host.ctx.storage.sql
    .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", entryId)
    .toArray()[0];
  return row ? toProgress(row) : undefined;
}
