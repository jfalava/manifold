import { Schema } from "effect";

import {
  AuthConnection,
  CanonicalIdentity,
  CanonicalSearchResponse,
  ListEvent,
  ListState,
  MangaDexEntryStat,
  MangaDexFeedPage,
  MangaDexLibraryItem,
  MangaDexLibrarySummary,
  MangaDexMatchResult,
  OAuthStart,
  OpsSummary,
  ReadingProgress,
  RegistryEntry,
  RegistryListEntry,
  RegistrySummary,
  SyncOp,
} from "./entities";
import { AuthProvider } from "./literals";

export const ErrorBody = Schema.Struct({
  error: Schema.String,
  details: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
});
export type ErrorBody = Schema.Schema.Type<typeof ErrorBody>;

export const HealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  environment: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
});
export type HealthResponse = Schema.Schema.Type<typeof HealthResponse>;

export const OkResponse = Schema.Struct({
  ok: Schema.Literal(true),
});
export type OkResponse = Schema.Schema.Type<typeof OkResponse>;

export const OkWithListStateResponse = Schema.Struct({
  ok: Schema.Literal(true),
  state: Schema.optional(ListState),
});
export type OkWithListStateResponse = Schema.Schema.Type<typeof OkWithListStateResponse>;

export const ProgressResponse = Schema.Struct({
  progress: Schema.NullOr(ReadingProgress),
});
export type ProgressResponse = Schema.Schema.Type<typeof ProgressResponse>;

export const ListStateResponse = Schema.Struct({
  state: Schema.NullOr(ListState),
});
export type ListStateResponse = Schema.Schema.Type<typeof ListStateResponse>;

export const EntryByProviderResponse = Schema.Struct({
  entry: Schema.NullOr(RegistryEntry),
});
export type EntryByProviderResponse = Schema.Schema.Type<typeof EntryByProviderResponse>;

export const RegistryEntriesResponse = Schema.Struct({
  entries: Schema.Array(RegistryEntry),
});
export type RegistryEntriesResponse = Schema.Schema.Type<typeof RegistryEntriesResponse>;

export const RegistryListResponse = Schema.Struct({
  entries: Schema.Array(RegistryListEntry),
});
export type RegistryListResponse = Schema.Schema.Type<typeof RegistryListResponse>;

export const OpsListResponse = Schema.Struct({
  ops: Schema.Array(SyncOp),
});
export type OpsListResponse = Schema.Schema.Type<typeof OpsListResponse>;

export const EventsListResponse = Schema.Struct({
  events: Schema.Array(ListEvent),
});
export type EventsListResponse = Schema.Schema.Type<typeof EventsListResponse>;

export const MangaDexLibraryResponse = Schema.Struct({
  library: Schema.Array(MangaDexLibraryItem),
});
export type MangaDexLibraryResponse = Schema.Schema.Type<typeof MangaDexLibraryResponse>;

export const MangaDexLibrarySummaryResponse = Schema.Struct({
  summary: MangaDexLibrarySummary,
});
export type MangaDexLibrarySummaryResponse = Schema.Schema.Type<
  typeof MangaDexLibrarySummaryResponse
>;

export const RegistrySummaryResponse = Schema.Struct({
  summary: RegistrySummary,
});
export type RegistrySummaryResponse = Schema.Schema.Type<typeof RegistrySummaryResponse>;

export const OpsSummaryResponse = Schema.Struct({
  summary: OpsSummary,
});
export type OpsSummaryResponse = Schema.Schema.Type<typeof OpsSummaryResponse>;

export const RegistryBackupMetadata = Schema.Struct({
  key: Schema.NonEmptyString,
  createdAt: Schema.Number,
  uploadedAt: Schema.Number,
  size: Schema.Number,
  databaseSize: Schema.Number,
  entryCount: Schema.Number,
  bookmark: Schema.NonEmptyString,
});
export type RegistryBackupMetadata = Schema.Schema.Type<typeof RegistryBackupMetadata>;

export const RegistryBackupResponse = Schema.Struct({
  backup: RegistryBackupMetadata,
});
export type RegistryBackupResponse = Schema.Schema.Type<typeof RegistryBackupResponse>;

export const RegistryBackupsResponse = Schema.Struct({
  backups: Schema.Array(RegistryBackupMetadata),
});
export type RegistryBackupsResponse = Schema.Schema.Type<typeof RegistryBackupsResponse>;

export const RegistryBackupRestoreResponse = Schema.Struct({
  restored: Schema.Literal(true),
  backup: RegistryBackupMetadata,
});
export type RegistryBackupRestoreResponse = Schema.Schema.Type<
  typeof RegistryBackupRestoreResponse
>;

export const MangaDexReadMarkersResponse = Schema.Struct({
  chapters: Schema.Array(Schema.String),
});
export type MangaDexReadMarkersResponse = Schema.Schema.Type<typeof MangaDexReadMarkersResponse>;

export const MangaDexUserResponse = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.String),
});
export type MangaDexUserResponse = Schema.Schema.Type<typeof MangaDexUserResponse>;

export const MangaDexStatsResponse = Schema.Struct({
  stats: Schema.Record(Schema.String, MangaDexEntryStat),
});
export type MangaDexStatsResponse = Schema.Schema.Type<typeof MangaDexStatsResponse>;

export const RecordedCountResponse = Schema.Struct({
  recorded: Schema.Number,
});
export type RecordedCountResponse = Schema.Schema.Type<typeof RecordedCountResponse>;

export const UpdatedCountResponse = Schema.Struct({
  updated: Schema.Number,
});
export type UpdatedCountResponse = Schema.Schema.Type<typeof UpdatedCountResponse>;

export const RetriedCountResponse = Schema.Struct({
  retried: Schema.Number,
});
export type RetriedCountResponse = Schema.Schema.Type<typeof RetriedCountResponse>;

export const EnqueuedCountResponse = Schema.Struct({
  enqueued: Schema.Number,
});
export type EnqueuedCountResponse = Schema.Schema.Type<typeof EnqueuedCountResponse>;

export const AuthDisconnectedResponse = Schema.Struct({
  provider: AuthProvider,
  connected: Schema.Literal(false),
});
export type AuthDisconnectedResponse = Schema.Schema.Type<typeof AuthDisconnectedResponse>;

export const AuthConnectionsResponse = Schema.Array(AuthConnection);
export type AuthConnectionsResponse = Schema.Schema.Type<typeof AuthConnectionsResponse>;

// Re-export entity schemas used as bare response bodies.
export {
  AuthConnection,
  CanonicalIdentity,
  CanonicalSearchResponse,
  ListState,
  MangaDexFeedPage,
  MangaDexMatchResult,
  OAuthStart,
  ReadingProgress,
  RegistryEntry,
  SyncOp,
};
