import { isFiniteNumber, isJsonObject, isString, type JsonValue } from "@manifold/json";

export const REGISTRY_BACKUP_PREFIX = "registry/";
export const REGISTRY_BACKUP_VERSION = 1 as const;
// JSON is materialized for transactional restore. Reject larger inputs before
// parsing rather than exhausting the Worker's memory during recovery.
export const MAX_REGISTRY_BACKUP_BYTES = 16 * 1024 * 1024;

export const REGISTRY_BACKUP_TABLE_COLUMNS = {
  canonical_entries: [
    "id",
    "provider",
    "provider_id",
    "title",
    "created_at",
    "updated_at",
    "tombstoned_at",
  ],
  provider_links: ["entry_id", "provider", "external_id", "title", "updated_at"],
  read_events: ["event_id", "entry_id", "chapter_key", "read_at"],
  progress_state: [
    "entry_id",
    "chapter_key",
    "chapter_number",
    "volume_number",
    "provider",
    "source_chapter_id",
    "read_at",
    "version",
  ],
  md_status_queue: ["entry_id", "created_at", "attempts"],
  md_feed_stats: ["manga_id", "payload", "computed_at"],
  oauth_tokens: [
    "provider",
    "access_token",
    "refresh_token",
    "token_type",
    "expires_at",
    "scope",
    "updated_at",
  ],
  list_state: [
    "entry_id",
    "status",
    "score",
    "notes",
    "started_at",
    "completed_at",
    "volume_progress",
    "media_list_entry_id",
    "updated_at",
  ],
  sync_ops: [
    "id",
    "op_id",
    "target",
    "kind",
    "origin",
    "payload",
    "state",
    "attempts",
    "last_error",
    "created_at",
    "updated_at",
  ],
  list_events: ["id", "entry_id", "kind", "origin", "detail", "created_at"],
} as const;

export const REGISTRY_BACKUP_TABLE_NAMES = [
  "canonical_entries",
  "provider_links",
  "read_events",
  "progress_state",
  "md_status_queue",
  "md_feed_stats",
  "oauth_tokens",
  "list_state",
  "sync_ops",
  "list_events",
] as const;

export type RegistryBackupTableName = keyof typeof REGISTRY_BACKUP_TABLE_COLUMNS;
export type BackupScalar = string | number | null;
export type BackupRow = Readonly<Record<string, BackupScalar>>;

export type RegistryBackupTables = {
  readonly [Table in RegistryBackupTableName]: readonly BackupRow[];
};

export interface RegistryBackup {
  readonly version: typeof REGISTRY_BACKUP_VERSION;
  readonly kind: "manifold-sync";
  readonly createdAt: number;
  readonly bookmark: string;
  readonly databaseSize: number;
  readonly tokenKeyHash: string;
  readonly tables: RegistryBackupTables;
}

export const backupKey = (createdAt: number): string =>
  `${REGISTRY_BACKUP_PREFIX}${createdAt}-${crypto.randomUUID()}.json`;

export const isRegistryBackupKey = (key: string): boolean => {
  if (!key.startsWith(REGISTRY_BACKUP_PREFIX) || key.includes("..") || !key.endsWith(".json")) {
    return false;
  }
  return /^registry\/\d+-[0-9a-f-]+\.json$/u.test(key);
};

/** Copy SQL rows into the JSON-safe subset used by durable backups. */
export const toBackupRows = (
  rows: readonly Record<string, string | number | ArrayBuffer | null>[],
  columns: readonly string[],
): readonly BackupRow[] =>
  rows.map((row) => {
    const copy: Record<string, BackupScalar> = {};
    for (const column of columns) {
      const value = row[column];
      if (value !== null && !isString(value) && !isFiniteNumber(value)) {
        throw new Error(`Backup column ${column} contains a non-JSON SQL value`);
      }
      copy[column] = value;
    }
    return copy;
  });

const isBackupScalar = (value: unknown): value is BackupScalar =>
  value === null || isString(value) || isFiniteNumber(value);

const parseRows = (value: JsonValue, table: RegistryBackupTableName): readonly BackupRow[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Backup table ${table} is not an array`);
  }
  const columns = REGISTRY_BACKUP_TABLE_COLUMNS[table];
  return value.map((rawRow, index) => {
    if (!isJsonObject(rawRow)) {
      throw new Error(`Backup table ${table} row ${index} is not an object`);
    }
    const row: Record<string, BackupScalar> = {};
    for (const column of columns) {
      if (!(column in rawRow) || !isBackupScalar(rawRow[column])) {
        throw new Error(`Backup table ${table} row ${index} is missing ${column}`);
      }
      row[column] = rawRow[column];
    }
    return row;
  });
};

export const parseRegistryBackup = (input: JsonValue): RegistryBackup => {
  if (!isJsonObject(input)) {
    throw new Error("Registry backup must be a JSON object");
  }
  if (input.version !== REGISTRY_BACKUP_VERSION || input.kind !== "manifold-sync") {
    throw new Error("Unsupported registry backup version");
  }
  if (!isFiniteNumber(input.createdAt) || !isString(input.bookmark)) {
    throw new Error("Registry backup metadata is invalid");
  }
  if (!isFiniteNumber(input.databaseSize) || !isJsonObject(input.tables)) {
    throw new Error("Registry backup tables are invalid");
  }
  if (!isString(input.tokenKeyHash) || !/^[a-f0-9]{64}$/u.test(input.tokenKeyHash)) {
    throw new Error("Registry backup encryption key fingerprint is invalid");
  }

  return {
    version: REGISTRY_BACKUP_VERSION,
    kind: "manifold-sync",
    createdAt: input.createdAt,
    bookmark: input.bookmark,
    databaseSize: input.databaseSize,
    tokenKeyHash: input.tokenKeyHash,
    tables: {
      canonical_entries: parseRows(input.tables.canonical_entries, "canonical_entries"),
      provider_links: parseRows(input.tables.provider_links, "provider_links"),
      read_events: parseRows(input.tables.read_events, "read_events"),
      progress_state: parseRows(input.tables.progress_state, "progress_state"),
      md_status_queue: parseRows(input.tables.md_status_queue, "md_status_queue"),
      md_feed_stats: parseRows(input.tables.md_feed_stats, "md_feed_stats"),
      oauth_tokens: parseRows(input.tables.oauth_tokens, "oauth_tokens"),
      list_state: parseRows(input.tables.list_state, "list_state"),
      sync_ops: parseRows(input.tables.sync_ops, "sync_ops"),
      list_events: parseRows(input.tables.list_events, "list_events"),
    },
  };
};

export const sha256 = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const readBackupBody = async (
  body: ReadableStream<Uint8Array>,
  expectedChecksum?: string,
): Promise<RegistryBackup> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_REGISTRY_BACKUP_BYTES) {
        await reader.cancel();
        throw new Error("Registry backup exceeds the 16 MiB recovery limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (expectedChecksum !== undefined && (await sha256(text)) !== expectedChecksum) {
    throw new Error("Registry backup checksum mismatch");
  }
  const parsed: JsonValue = JSON.parse(text);
  return parseRegistryBackup(parsed);
};
