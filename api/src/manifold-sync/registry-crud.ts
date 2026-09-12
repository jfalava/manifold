import {
  appendEvent,
  getProgressSync,
  readEntry,
  readListState,
  requireEntry,
} from "./sql-helpers";
import type { SyncHost } from "./host";
import { now } from "./constants";
import type {
  RegistryEntry,
  RegistryListEntry,
  LinkProviderInput,
  ListState,
  ReadingProgress,
  RegistrySummary,
  UpsertEntryInput,
} from "../domain";
import { type EntryRow, type ProgressRow, toProgress } from "../sync-rows";

export function upsertEntry(host: SyncHost, input: UpsertEntryInput): RegistryEntry {
  const timestamp = now();
  host.ctx.storage.sql.exec(
    `INSERT INTO canonical_entries
       (id, provider, provider_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider,
       provider_id = excluded.provider_id,
       title = excluded.title,
       updated_at = excluded.updated_at`,
    input.id,
    input.provider,
    input.providerId,
    input.title,
    timestamp,
    timestamp,
  );
  const stored = readEntry(host, input.id);
  if (!stored) {
    throw new Error(`Canonical entry not found after write: ${input.id}`);
  }
  return stored;
}

export function listEntries(host: SyncHost): readonly RegistryEntry[] {
  const rows = host.ctx.storage.sql
    .exec<EntryRow>("SELECT * FROM canonical_entries ORDER BY updated_at DESC")
    .toArray();
  return rows
    .map((row) => readEntry(host, row.id))
    .filter((entry): entry is RegistryEntry => entry !== undefined);
}

export function getEntry(host: SyncHost, entryId: string): RegistryEntry | undefined {
  return readEntry(host, entryId, false);
}

export function getProgress(host: SyncHost, entryId: string): ReadingProgress | undefined {
  const row = host.ctx.storage.sql
    .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", entryId)
    .toArray()[0];
  return row ? toProgress(row) : undefined;
}

export function searchRegistry(
  host: SyncHost,
  query: string,
  limit = 25,
): readonly RegistryEntry[] {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
  const escaped = normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const pattern = `%${escaped}%`;
  const rows = host.ctx.storage.sql
    .exec<EntryRow>(
      `SELECT DISTINCT ce.* FROM canonical_entries ce
       LEFT JOIN provider_links pl ON pl.entry_id = ce.id
       WHERE ce.tombstoned_at IS NULL
         AND (ce.title LIKE ? ESCAPE '\\' OR pl.title LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN lower(ce.title) = lower(?) THEN 0 ELSE 1 END,
                ce.updated_at DESC
       LIMIT ?`,
      pattern,
      pattern,
      normalized,
      safeLimit,
    )
    .toArray();
  return rows.flatMap((row) => {
    const entry = readEntry(host, row.id, false);
    return entry ? [entry] : [];
  });
}

export function listRegistry(
  host: SyncHost,
  limit = 500,
  offset = 0,
): readonly RegistryListEntry[] {
  const safeLimit = Math.min(5000, Math.max(1, Math.trunc(limit)));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const results: (RegistryEntry & {
    state?: ListState;
    progress?: ReadingProgress;
    tombstoned?: boolean;
  })[] = [];
  for (const row of host.ctx.storage.sql
    .exec<EntryRow>(
      "SELECT * FROM canonical_entries ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
      safeLimit,
      safeOffset,
    )
    .toArray()) {
    const entry = readEntry(host, row.id, false);
    if (!entry) {
      continue;
    }
    const state = readListState(host, row.id);
    const progress = getProgressSync(host, row.id);
    results.push({
      ...entry,
      ...(state && { state }),
      ...(progress && { progress }),
      ...(row.tombstoned_at !== null && { tombstoned: true }),
    });
  }
  return results;
}

export function registrySummary(host: SyncHost): RegistrySummary {
  const total =
    host.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM canonical_entries")
      .toArray()[0]?.count ?? 0;
  const tombstoned =
    host.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM canonical_entries WHERE tombstoned_at IS NOT NULL",
      )
      .toArray()[0]?.count ?? 0;
  const active = total - tombstoned;

  const statusRows = host.ctx.storage.sql
    .exec<{ status: string | null; count: number }>(
      `SELECT ls.status AS status, COUNT(*) AS count
           FROM canonical_entries ce
           LEFT JOIN list_state ls ON ls.entry_id = ce.id
           WHERE ce.tombstoned_at IS NULL
           GROUP BY ls.status`,
    )
    .toArray();
  const statuses: Record<string, number> = {};
  for (const row of statusRows) {
    const key = row.status && row.status.length > 0 ? row.status : "unset";
    statuses[key] = (statuses[key] ?? 0) + row.count;
  }

  const providerRows = host.ctx.storage.sql
    .exec<{ provider: string; count: number }>(
      `SELECT pl.provider AS provider, COUNT(DISTINCT pl.entry_id) AS count
           FROM provider_links pl
           JOIN canonical_entries ce ON ce.id = pl.entry_id
           WHERE ce.tombstoned_at IS NULL
           GROUP BY pl.provider`,
    )
    .toArray();
  const providerCounts: Record<string, number> = {};
  for (const row of providerRows) {
    providerCounts[row.provider] = row.count;
  }

  const fullyLinked =
    host.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (
               SELECT ce.id AS id
               FROM canonical_entries ce
               JOIN provider_links pl ON pl.entry_id = ce.id
               WHERE ce.tombstoned_at IS NULL
                 AND pl.provider IN ('anilist', 'mal', 'mangadex')
               GROUP BY ce.id
               HAVING COUNT(DISTINCT pl.provider) = 3
             ) AS fully_linked`,
      )
      .toArray()[0]?.count ?? 0;

  const unlinked =
    host.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
             FROM canonical_entries ce
             LEFT JOIN provider_links pl ON pl.entry_id = ce.id
             WHERE ce.tombstoned_at IS NULL AND pl.entry_id IS NULL`,
      )
      .toArray()[0]?.count ?? 0;

  return {
    total,
    active,
    tombstoned,
    statuses,
    providerCounts,
    fullyLinked,
    unlinked,
  };
}

export function linkProvider(
  host: SyncHost,
  entryId: string,
  input: LinkProviderInput,
): RegistryEntry {
  const timestamp = now();
  requireEntry(host, entryId);
  const stolen = host.ctx.storage.sql
    .exec<{ entry_id: string }>(
      "SELECT entry_id FROM provider_links WHERE provider = ? AND external_id = ? AND entry_id <> ?",
      input.provider,
      input.externalId,
      entryId,
    )
    .toArray()[0];
  if (stolen) {
    host.ctx.storage.sql.exec(
      "DELETE FROM provider_links WHERE entry_id = ? AND provider = ?",
      stolen.entry_id,
      input.provider,
    );
  }
  host.ctx.storage.sql.exec(
    `INSERT INTO provider_links
       (entry_id, provider, external_id, title, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entry_id, provider) DO UPDATE SET
       external_id = excluded.external_id,
       title = excluded.title,
       updated_at = excluded.updated_at`,
    entryId,
    input.provider,
    input.externalId,
    input.title ?? null,
    timestamp,
  );
  appendEvent(host, entryId, "link.set", "admin", {
    provider: input.provider,
    externalId: input.externalId,
  });
  const stored = readEntry(host, entryId);
  if (!stored) {
    throw new Error(`Canonical entry not found after link: ${entryId}`);
  }
  return stored;
}

export function unlinkProvider(host: SyncHost, entryId: string, provider: string): RegistryEntry {
  requireEntry(host, entryId);
  host.ctx.storage.sql.exec(
    "DELETE FROM provider_links WHERE entry_id = ? AND provider = ?",
    entryId,
    provider,
  );
  appendEvent(host, entryId, "link.remove", "admin", { provider });
  const stored = readEntry(host, entryId);
  if (!stored) {
    throw new Error(`Canonical entry not found after unlink: ${entryId}`);
  }
  return stored;
}
