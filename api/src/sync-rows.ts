import { isFiniteNumber, isJsonObject, type JsonObject } from "@manifold/json";
import type {
  RegistryEntry,
  ListEvent,
  ListState,
  OpKind,
  OpOrigin,
  OpState,
  OpTarget,
  OAuthProvider,
  AuthProvider,
  ProviderLink,
  ReadingProgress,
  SyncOp,
  UpdateProbeFailure,
  UpdateProbeReason,
  UpdateProbeSource,
} from "./domain";

export interface EntryRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: RegistryEntry["provider"];
  provider_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  tombstoned_at: number | null;
  chapter_source: string | null;
}

export interface ProviderRow extends Record<string, SqlStorageValue> {
  provider: ProviderLink["provider"];
  external_id: string;
  title: string | null;
  updated_at: number;
}

export interface ProgressRow extends Record<string, SqlStorageValue> {
  entry_id: string;
  chapter_key: string;
  chapter_number: number | null;
  volume_number: number | null;
  provider: NonNullable<ReadingProgress["provider"]> | null;
  source_chapter_id: string | null;
  read_at: number;
  version: number;
}

export interface OpRow extends Record<string, SqlStorageValue> {
  id: number;
  op_id: string;
  target: OpTarget;
  kind: OpKind;
  origin: OpOrigin;
  payload: string;
  state: OpState;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ListStateRow extends Record<string, SqlStorageValue> {
  entry_id: string;
  status: string | null;
  score: number | null;
  notes: string | null;
  started_at: string | null;
  completed_at: string | null;
  volume_progress: number | null;
  media_list_entry_id: number | null;
  updated_at: number;
}

export interface ListEventRow extends Record<string, SqlStorageValue> {
  id: number;
  entry_id: string;
  kind: string;
  origin: OpOrigin;
  detail: string | null;
  created_at: number;
}

export interface UpdateProbeFailureRow extends Record<string, SqlStorageValue> {
  id: number;
  entry_id: string | null;
  title: string;
  source: UpdateProbeSource;
  reason: UpdateProbeReason;
  detail: string | null;
  created_at: number;
}

export interface OAuthSessionRow extends Record<string, SqlStorageValue> {
  provider: OAuthProvider;
  state: string;
  code_verifier: string | null;
  redirect_uri: string;
  return_path: string | null;
  created_at: number;
}

export interface OAuthTokenRow extends Record<string, SqlStorageValue> {
  provider: AuthProvider;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_at: number | null;
  scope: string | null;
  updated_at: number;
}

const parseStoredJsonObject = (text: string): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { raw: text };
  }
  return isJsonObject(parsed) ? parsed : { raw: text };
};

export const toProgress = (row: ProgressRow): ReadingProgress => ({
  entryId: row.entry_id,
  chapterKey: row.chapter_key,
  ...(!(row.chapter_number === null) && { chapterNumber: row.chapter_number }),
  ...(!(row.volume_number === null) && { volumeNumber: row.volume_number }),
  ...(!(row.provider === null) && { provider: row.provider }),
  ...(!(row.source_chapter_id === null) && { sourceChapterId: row.source_chapter_id }),
  readAt: row.read_at,
  version: row.version,
});

export const toOp = (row: OpRow): SyncOp => ({
  id: row.id,
  opId: row.op_id,
  target: row.target,
  kind: row.kind,
  origin: row.origin,
  payload: parseStoredJsonObject(row.payload),
  state: row.state,
  attempts: row.attempts,
  ...(!(row.last_error === null) && { lastError: row.last_error }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toListState = (row: ListStateRow): ListState => ({
  entryId: row.entry_id,
  // SAFETY: value matches ListState["status"] when the stored column is set
  ...(!(row.status === null) && { status: row.status as ListState["status"] }),
  ...(!(row.score === null) && { score: row.score }),
  ...(!(row.notes === null) && { notes: row.notes }),
  ...(!(row.started_at === null) && { startedAt: row.started_at }),
  ...(!(row.completed_at === null) && { completedAt: row.completed_at }),
  ...(!(row.volume_progress === null) && { volumeProgress: row.volume_progress }),
  ...(!(row.media_list_entry_id === null) && { mediaListEntryId: row.media_list_entry_id }),
  updatedAt: row.updated_at,
});

export const toListEvent = (row: ListEventRow): ListEvent => ({
  id: row.id,
  entryId: row.entry_id,
  kind: row.kind,
  origin: row.origin,
  ...(row.detail && { detail: parseStoredJsonObject(row.detail) }),
  createdAt: row.created_at,
});

export const toUpdateProbeFailure = (row: UpdateProbeFailureRow): UpdateProbeFailure => ({
  id: row.id,
  ...(row.entry_id !== null && { entryId: row.entry_id }),
  title: row.title,
  source: row.source,
  reason: row.reason,
  ...(row.detail !== null && { detail: row.detail }),
  createdAt: row.created_at,
});

const CANONICAL_PROVIDERS: ReadonlySet<string> = new Set([
  "anilist",
  "mal",
  "local",
]);
const REGISTRY_PROVIDERS: ReadonlySet<string> = new Set([
  "anilist",
  "mal",
  "mangadex",
  "comix",
]);

const isRegistryProvider = (
  provider: string,
): provider is ProviderLink["provider"] => REGISTRY_PROVIDERS.has(provider);

const isCanonicalProvider = (
  provider: string,
): provider is RegistryEntry["provider"] => CANONICAL_PROVIDERS.has(provider);

const nonEmpty = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const finiteMs = (value: number | null | undefined, fallback: number): number =>
  isFiniteNumber(value) ? value : fallback;

/**
 * Build a wire-safe RegistryEntry from durable rows.
 * Drops corrupt provider links and coerces empty required strings so response
 * encode never 500s on historical DO data (empty external_id, bad provider, …).
 */
export const toRegistryEntry = (
  row: EntryRow,
  providerRows: readonly ProviderRow[],
): RegistryEntry => {
  const nowMs = Date.now();
  const providers: ProviderLink[] = [];
  for (const link of providerRows) {
    if (!isRegistryProvider(link.provider)) {
      continue;
    }
    const externalId = nonEmpty(link.external_id);
    if (!externalId) {
      continue;
    }
    const title = nonEmpty(link.title);
    providers.push({
      provider: link.provider,
      externalId,
      ...(title !== undefined && { title }),
      updatedAt: finiteMs(link.updated_at, nowMs),
    });
  }

  const provider: RegistryEntry["provider"] = isCanonicalProvider(row.provider)
    ? row.provider
    : "local";
  const providerId = nonEmpty(row.provider_id) ?? row.id;
  const title = nonEmpty(row.title) ?? providerId;
  const rawChapterSource = row.chapter_source ?? null;
  const chapterSource =
    rawChapterSource === "mangadex" || rawChapterSource === "comix"
      ? rawChapterSource
      : undefined;

  return {
    id: nonEmpty(row.id) ?? row.id,
    provider,
    providerId,
    title,
    createdAt: finiteMs(row.created_at, nowMs),
    updatedAt: finiteMs(row.updated_at, nowMs),
    providers,
    ...(chapterSource && { chapterSource }),
  };
};
