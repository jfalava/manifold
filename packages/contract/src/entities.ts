import { Schema } from "effect";

import {
  AuthProvider,
  CanonicalProvider,
  ContentProvider,
  ListStatus,
  MangaDexMatchMethod,
  MangaDexMatchStatus,
  OpKind,
  OpOrigin,
  OpState,
  OpTarget,
  RegistryProvider,
} from "./literals";

export const ProviderLink = Schema.Struct({
  provider: RegistryProvider,
  externalId: Schema.NonEmptyString,
  title: Schema.optional(Schema.String),
  updatedAt: Schema.Finite,
});
export type ProviderLink = Schema.Schema.Type<typeof ProviderLink>;

export const ListState = Schema.Struct({
  entryId: Schema.NonEmptyString,
  status: Schema.optional(ListStatus),
  score: Schema.optional(Schema.Finite),
  notes: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  volumeProgress: Schema.optional(Schema.Finite),
  mediaListEntryId: Schema.optional(Schema.Finite),
  updatedAt: Schema.Finite,
});
export type ListState = Schema.Schema.Type<typeof ListState>;

/** Registry UUID row + provider links (HTTP/personal API). */
export const RegistryEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: CanonicalProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  providers: Schema.Array(ProviderLink),
});
export type RegistryEntry = Schema.Schema.Type<typeof RegistryEntry>;

export const ReadingProgress = Schema.Struct({
  entryId: Schema.NonEmptyString,
  chapterKey: Schema.NonEmptyString,
  chapterNumber: Schema.optional(Schema.Finite),
  volumeNumber: Schema.optional(Schema.Finite),
  provider: Schema.optional(ContentProvider),
  sourceChapterId: Schema.optional(Schema.NonEmptyString),
  readAt: Schema.Finite,
  version: Schema.Finite,
});
export type ReadingProgress = Schema.Schema.Type<typeof ReadingProgress>;

/** Registry list row includes optional list/progress state + tombstone flag. */
export const RegistryListEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: CanonicalProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  providers: Schema.Array(ProviderLink),
  state: Schema.optional(ListState),
  progress: Schema.optional(ReadingProgress),
  tombstoned: Schema.optional(Schema.Boolean),
});
export type RegistryListEntry = Schema.Schema.Type<typeof RegistryListEntry>;

export const ListEvent = Schema.Struct({
  id: Schema.Finite,
  entryId: Schema.NonEmptyString,
  kind: Schema.String,
  origin: OpOrigin,
  detail: Schema.optional(Schema.JsonObject),
  createdAt: Schema.Finite,
});
export type ListEvent = Schema.Schema.Type<typeof ListEvent>;

export const SyncOp = Schema.Struct({
  id: Schema.Finite,
  opId: Schema.NonEmptyString,
  target: OpTarget,
  kind: OpKind,
  origin: OpOrigin,
  payload: Schema.JsonObject,
  state: OpState,
  attempts: Schema.Finite,
  lastError: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export type SyncOp = Schema.Schema.Type<typeof SyncOp>;

export const MangaDexLibraryItem = Schema.Struct({
  mangaDexId: Schema.NonEmptyString,
  status: Schema.String,
  entryId: Schema.NullOr(Schema.String),
  title: Schema.optional(Schema.String),
  coverUrl: Schema.optional(Schema.String),
  hasRating: Schema.optional(Schema.Boolean),
  rating: Schema.optional(Schema.Finite),
  ratingCreatedAt: Schema.optional(Schema.String),
});
export type MangaDexLibraryItem = Schema.Schema.Type<typeof MangaDexLibraryItem>;

export const MangaDexLibrarySummary = Schema.Struct({
  total: Schema.Finite,
  statuses: Schema.Record(Schema.String, Schema.Finite),
  rated: Schema.Finite,
  meanRating: Schema.NullOr(Schema.Finite),
  linkedToRegistry: Schema.Finite,
});
export type MangaDexLibrarySummary = Schema.Schema.Type<typeof MangaDexLibrarySummary>;

export const RegistrySummary = Schema.Struct({
  total: Schema.Finite,
  active: Schema.Finite,
  tombstoned: Schema.Finite,
  statuses: Schema.Record(Schema.String, Schema.Finite),
  providerCounts: Schema.Record(Schema.String, Schema.Finite),
  fullyLinked: Schema.Finite,
  unlinked: Schema.Finite,
});
export type RegistrySummary = Schema.Schema.Type<typeof RegistrySummary>;

export const OpsSummary = Schema.Struct({
  total: Schema.Finite,
  states: Schema.Record(Schema.String, Schema.Finite),
  oldestPendingAt: Schema.NullOr(Schema.Finite),
  lastFailedError: Schema.NullOr(Schema.String),
  shelfPending: Schema.Finite,
  shelfBlocked: Schema.Finite,
  shelfLastBlockedError: Schema.NullOr(Schema.String),
});
export type OpsSummary = Schema.Schema.Type<typeof OpsSummary>;

export const AuthConnection = Schema.Struct({
  provider: AuthProvider,
  connected: Schema.Boolean,
  expiresAt: Schema.optional(Schema.Finite),
  updatedAt: Schema.optional(Schema.Finite),
  returnPath: Schema.optional(Schema.String),
});
export type AuthConnection = Schema.Schema.Type<typeof AuthConnection>;

export const OAuthStart = Schema.Struct({
  provider: Schema.Literals(["anilist", "mal"]),
  authorizationUrl: Schema.NonEmptyString,
});
export type OAuthStart = Schema.Schema.Type<typeof OAuthStart>;

export const MangaDexMatchCandidate = Schema.Struct({
  externalId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  score: Schema.Finite,
  anilistId: Schema.optional(Schema.String),
  myAnimeListId: Schema.optional(Schema.String),
});
export type MangaDexMatchCandidate = Schema.Schema.Type<typeof MangaDexMatchCandidate>;

export const MangaDexMatchResult = Schema.Struct({
  canonicalId: Schema.NonEmptyString,
  status: MangaDexMatchStatus,
  candidates: Schema.Array(MangaDexMatchCandidate),
  externalId: Schema.optional(Schema.NonEmptyString),
  title: Schema.optional(Schema.String),
  method: Schema.optional(MangaDexMatchMethod),
  score: Schema.optional(Schema.Finite),
  margin: Schema.optional(Schema.Finite),
});
export type MangaDexMatchResult = Schema.Schema.Type<typeof MangaDexMatchResult>;

export const CanonicalExternalIds = Schema.Struct({
  anilist: Schema.optional(Schema.String),
  mal: Schema.optional(Schema.String),
  mangadex: Schema.optional(Schema.String),
});
export type CanonicalExternalIds = Schema.Schema.Type<typeof CanonicalExternalIds>;

export const CanonicalMetadata = Schema.Struct({
  description: Schema.optional(Schema.String),
  coverUrl: Schema.optional(Schema.String),
  chapters: Schema.optional(Schema.Finite),
  volumes: Schema.optional(Schema.Finite),
  startDate: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
export type CanonicalMetadata = Schema.Schema.Type<typeof CanonicalMetadata>;

/** Search-identity hit (AniList/MAL), not a registry row. */
export const CanonicalSearchHit = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: CanonicalProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  externalIds: Schema.optional(CanonicalExternalIds),
  metadata: Schema.optional(CanonicalMetadata),
  score: Schema.Finite,
});
export type CanonicalSearchHit = Schema.Schema.Type<typeof CanonicalSearchHit>;

export const CanonicalProviderSearch = Schema.Struct({
  provider: Schema.Literals(["anilist", "mal"]),
  results: Schema.Array(CanonicalSearchHit),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.NonEmptyString,
      status: Schema.optional(Schema.Finite),
    }),
  ),
});
export type CanonicalProviderSearch = Schema.Schema.Type<typeof CanonicalProviderSearch>;

export const CanonicalSearchResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(CanonicalSearchHit),
  providers: Schema.Array(CanonicalProviderSearch),
});
export type CanonicalSearchResponse = Schema.Schema.Type<typeof CanonicalSearchResponse>;

/** AniList/MAL get-by-id body (no score). */
export const CanonicalIdentity = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: CanonicalProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  externalIds: Schema.optional(CanonicalExternalIds),
  metadata: Schema.optional(CanonicalMetadata),
});
export type CanonicalIdentity = Schema.Schema.Type<typeof CanonicalIdentity>;

export const MangaDexChapter = Schema.Struct({
  id: Schema.NonEmptyString,
  mangaId: Schema.NonEmptyString,
  chapterNumber: Schema.optional(Schema.Finite),
  volumeNumber: Schema.optional(Schema.Finite),
  language: Schema.String,
  title: Schema.optional(Schema.String),
  externalUrl: Schema.optional(Schema.String),
  pageCount: Schema.optional(Schema.Finite),
  publishedAt: Schema.optional(Schema.Finite),
});
export type MangaDexChapter = Schema.Schema.Type<typeof MangaDexChapter>;

export const MangaDexFeedPage = Schema.Struct({
  items: Schema.Array(MangaDexChapter),
  total: Schema.optional(Schema.Finite),
  limit: Schema.optional(Schema.Finite),
  offset: Schema.optional(Schema.Finite),
});
export type MangaDexFeedPage = Schema.Schema.Type<typeof MangaDexFeedPage>;

export const MangaDexEntryStat = Schema.Struct({
  lastRead: Schema.NullOr(Schema.Finite),
  readChapters: Schema.NullOr(Schema.Finite),
  totalListed: Schema.NullOr(Schema.Finite),
  latestChapter: Schema.NullOr(Schema.Finite),
  latestDate: Schema.NullOr(Schema.String),
  percent: Schema.NullOr(Schema.Finite),
});
export type MangaDexEntryStat = Schema.Schema.Type<typeof MangaDexEntryStat>;
