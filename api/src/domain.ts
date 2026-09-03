import { Schema } from "effect";
import type { JsonObject } from "@manifold/json";

export const CanonicalProvider = Schema.Literals(["anilist", "mal", "local"]);
export type CanonicalProvider = Schema.Schema.Type<typeof CanonicalProvider>;

export const ContentProvider = Schema.Literals(["mangadex", "comix"]);
export type ContentProvider = Schema.Schema.Type<typeof ContentProvider>;

// Per-entry chapter list pin. `auto` keeps the device's MangaDex-trust /
// richer-list heuristic; mangadex/comix skip comparison and load that source.
export const ChapterSource = Schema.Literals(["auto", "mangadex", "comix"]);
export type ChapterSource = Schema.Schema.Type<typeof ChapterSource>;

// Every provider that can appear in canonical_links. Registry entries are
// provider-neutral rows keyed by a minted UUID; links resolve them.
export const RegistryProvider = Schema.Literals(["anilist", "mal", "mangadex", "comix"]);
export type RegistryProvider = Schema.Schema.Type<typeof RegistryProvider>;

// The six AniList media list statuses, in registry vocabulary.
export const ListStatus = Schema.Literals([
  "reading",
  "on_hold",
  "plan_to_read",
  "dropped",
  "re_reading",
  "completed"
]);
export type ListStatus = Schema.Schema.Type<typeof ListStatus>;

export const SetListStateInput = Schema.Struct({
  status: Schema.optional(Schema.NullOr(ListStatus)),
  score: Schema.optional(Schema.NullOr(Schema.Number)),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  volumeProgress: Schema.optional(Schema.NullOr(Schema.Number)),
  // Where the mutation came from; decides whether an anilist op is enqueued
  // (device-originated mutations were already applied on the device).
  origin: Schema.optional(Schema.Literals(["device", "admin", "cli", "migration"])),
  appliedRemotely: Schema.optional(Schema.Boolean)
});
export type SetListStateInput = Schema.Schema.Type<typeof SetListStateInput>;

export interface ListState {
  readonly entryId: string;
  readonly status?: ListStatus;
  readonly score?: number;
  readonly notes?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly volumeProgress?: number;
  readonly mediaListEntryId?: number;
  readonly updatedAt: number;
}

export interface ListEvent {
  readonly id: number;
  readonly entryId: string;
  readonly kind: string;
  readonly origin: OpOrigin;
  readonly detail?: JsonObject;
  readonly createdAt: number;
}

export const AuthProvider = Schema.Literals(["anilist", "mal", "mangadex"]);
export type AuthProvider = Schema.Schema.Type<typeof AuthProvider>;

export const OAuthProvider = Schema.Literals(["anilist", "mal"]);
export type OAuthProvider = Schema.Schema.Type<typeof OAuthProvider>;

export const UpsertEntryInput = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: CanonicalProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString
});
export type UpsertEntryInput = Schema.Schema.Type<typeof UpsertEntryInput>;

export const LinkProviderInput = Schema.Struct({
  provider: RegistryProvider,
  externalId: Schema.NonEmptyString,
  title: Schema.optional(Schema.String)
});
export type LinkProviderInput = Schema.Schema.Type<typeof LinkProviderInput>;

export const SetChapterSourceInput = Schema.Struct({
  chapterSource: ChapterSource,
  origin: Schema.optional(Schema.Literals(["device", "admin", "cli", "migration"])),
});
export type SetChapterSourceInput = Schema.Schema.Type<typeof SetChapterSourceInput>;

export const ResolveEntryInput = Schema.Struct({
  provider: RegistryProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString
});
export type ResolveEntryInput = Schema.Schema.Type<typeof ResolveEntryInput>;

export const RecordReadInput = Schema.Struct({
  eventId: Schema.optional(Schema.NonEmptyString),
  chapterKey: Schema.NonEmptyString,
  chapterNumber: Schema.optional(Schema.Number),
  volumeNumber: Schema.optional(Schema.Number),
  provider: Schema.optional(ContentProvider),
  sourceChapterId: Schema.optional(Schema.NonEmptyString),
  readAt: Schema.optional(Schema.Number)
});
export type RecordReadInput = Schema.Schema.Type<typeof RecordReadInput>;

export interface ProviderLink {
  readonly provider: RegistryProvider;
  readonly externalId: string;
  readonly title?: string;
  readonly updatedAt: number;
}

export interface CanonicalEntry {
  readonly id: string;
  readonly provider: CanonicalProvider;
  readonly providerId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providers: readonly ProviderLink[];
  /** Chapter list pin. Omitted or `auto` = device heuristic. */
  readonly chapterSource?: ChapterSource;
}

export interface ReadingProgress {
  readonly entryId: string;
  readonly chapterKey: string;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly provider?: ContentProvider;
  readonly sourceChapterId?: string;
  readonly readAt: number;
  readonly version: number;
}

export const OpTarget = Schema.Literals(["mangadex", "anilist"]);
export type OpTarget = Schema.Schema.Type<typeof OpTarget>;

export const OpKind = Schema.Literals([
  "mangadex.read",
  "anilist.status",
  "anilist.progress",
  "anilist.fields",
  "anilist.delete"
]);
export type OpKind = Schema.Schema.Type<typeof OpKind>;

export const OpOrigin = Schema.Literals(["device", "admin", "cli", "migration"]);
export type OpOrigin = Schema.Schema.Type<typeof OpOrigin>;

export const OpState = Schema.Literals(["pending", "completed", "failed", "blocked"]);
export type OpState = Schema.Schema.Type<typeof OpState>;

// One mutation waiting to reach an upstream. mangadex:* ops drain on the
// Worker alarm; anilist:* ops wait for the device (AniList blocks Worker IPs).
export interface SyncOp {
  readonly id: number;
  readonly opId: string;
  readonly target: OpTarget;
  readonly kind: OpKind;
  readonly origin: OpOrigin;
  readonly payload: JsonObject;
  readonly state: OpState;
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const CompleteOpsInput = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    opId: Schema.NonEmptyString,
    ok: Schema.Boolean,
    error: Schema.optional(Schema.String),
    mediaListEntryId: Schema.optional(Schema.Number)
  }))
});
export type CompleteOpsInput = Schema.Schema.Type<typeof CompleteOpsInput>;

export const SetMangaDexStatusInput = Schema.Struct({
  status: Schema.NullOr(ListStatus),
});
export type SetMangaDexStatusInput = Schema.Schema.Type<typeof SetMangaDexStatusInput>;

export const NukeEntryInput = Schema.Struct({
  origin: Schema.optional(OpOrigin),
});
export type NukeEntryInput = Schema.Schema.Type<typeof NukeEntryInput>;

// Discover "My Updates" probe outcomes reported from the device so admin can
// see which library titles failed to resolve a freshest-chapter card and why.
export const UpdateProbeSource = Schema.Literals(["MD", "Comix"]);
export type UpdateProbeSource = Schema.Schema.Type<typeof UpdateProbeSource>;

export const UpdateProbeReason = Schema.Literals([
  "md_unresolved",
  "md_no_hosted_chapter",
  "comix_hid_miss",
  "comix_empty",
  "cloudflare",
  "error",
]);
export type UpdateProbeReason = Schema.Schema.Type<typeof UpdateProbeReason>;

export const UpdateProbeFailureInput = Schema.Struct({
  entryId: Schema.optional(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  source: UpdateProbeSource,
  reason: UpdateProbeReason,
  detail: Schema.optional(Schema.String),
});
export type UpdateProbeFailureInput = Schema.Schema.Type<typeof UpdateProbeFailureInput>;

export const ReportUpdateFailuresInput = Schema.Struct({
  failures: Schema.Array(UpdateProbeFailureInput),
});
export type ReportUpdateFailuresInput = Schema.Schema.Type<typeof ReportUpdateFailuresInput>;

export interface UpdateProbeFailure {
  readonly id: number;
  readonly entryId?: string;
  readonly title: string;
  readonly source: UpdateProbeSource;
  readonly reason: UpdateProbeReason;
  readonly detail?: string;
  readonly createdAt: number;
}

export interface MangaDexLibraryItem {
  readonly mangaDexId: string;
  readonly status: string;
  readonly entryId: string | null;
  readonly title?: string;
  readonly coverUrl?: string;
  readonly hasRating?: boolean;
  readonly rating?: number;
  readonly ratingCreatedAt?: string;
}

/** Compact MangaDex shelf metrics for the admin Overview (no titles/covers). */
export interface MangaDexLibrarySummary {
  readonly total: number;
  readonly statuses: Record<string, number>;
  readonly rated: number;
  readonly meanRating: number | null;
  /** Shelf items already resolved to a canonical registry entry. */
  readonly linkedToRegistry: number;
}

/** Compact registry metrics for the admin Overview (SQL aggregates, no entry rows). */
export interface RegistrySummary {
  readonly total: number;
  readonly active: number;
  readonly tombstoned: number;
  /** Active entries by list status; entries without list state count as "unset". */
  readonly statuses: Record<string, number>;
  /** Active entries linked to each provider. */
  readonly providerCounts: Record<string, number>;
  /** Active entries linked to every tracker provider (anilist + mal + mangadex). */
  readonly fullyLinked: number;
  /** Active entries with no provider links at all. */
  readonly unlinked: number;
}

/** Compact outbox metrics for the admin Overview (recent window, not full op rows). */
export interface OpsSummary {
  readonly total: number;
  readonly states: Record<string, number>;
  readonly oldestPendingAt: number | null;
  readonly lastFailedError: string | null;
}

export interface AuthConnection {
  readonly provider: AuthProvider;
  readonly connected: boolean;
  readonly expiresAt?: number;
  readonly updatedAt?: number;
}
