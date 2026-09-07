import type * as Effect from "effect/Effect";

export type CanonicalProvider = "anilist" | "mal" | "local";

export interface CanonicalEntry {
  readonly id: string;
  readonly provider: CanonicalProvider;
  readonly providerId: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly externalIds?: CanonicalExternalIds;
  readonly metadata?: CanonicalMetadata;
}

export interface CanonicalSearchResult extends CanonicalEntry {
  readonly score: number;
}

export interface CanonicalExternalIds {
  readonly anilist?: string;
  readonly mal?: string;
  readonly mangadex?: string;
}

export interface CanonicalMetadata {
  readonly description?: string;
  readonly coverUrl?: string;
  readonly chapters?: number;
  readonly volumes?: number;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly status?: string;
}

export interface CanonicalSearchOptions {
  readonly limit?: number;
}

export interface CanonicalProgress {
  readonly entryId: string;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly updatedAt: number;
}

// Registry vocabulary for the six AniList media list statuses. The registry
// row (D1) owns these values; AniList mirrors them.
export type CanonicalListStatus =
  | "reading"
  | "on_hold"
  | "plan_to_read"
  | "dropped"
  | "re_reading"
  | "completed";

export interface CanonicalListState {
  readonly entryId: string;
  readonly status?: CanonicalListStatus;
  readonly score?: number;
  readonly notes?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly volumeProgress?: number;
  readonly mediaListEntryId?: number;
  readonly updatedAt: number;
}

// A desired list-state mutation. `appliedRemotely` marks mutations the device
// already pushed to AniList itself (no op is enqueued for those).
export interface MalBackupIdentity {
  readonly anilistId: string;
  readonly malId?: string;
  readonly titles: readonly string[];
}

export interface CanonicalListStateChange {
  readonly origin: "device" | "admin" | "cli" | "migration";
  readonly appliedRemotely?: boolean;
  readonly backupIdentity?: MalBackupIdentity;
  readonly status?: CanonicalListStatus | null;
  readonly score?: number | null;
  readonly notes?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly volumeProgress?: number | null;
}

export interface CanonicalSourceError {
  readonly _tag: "CanonicalSourceError";
  readonly provider: Exclude<CanonicalProvider, "local">;
  readonly message: string;
  readonly status?: number;
}

export interface CanonicalSource {
  readonly provider: Exclude<CanonicalProvider, "local">;
  readonly search: (
    query: string,
    options?: CanonicalSearchOptions
  ) => Effect.Effect<readonly CanonicalSearchResult[], CanonicalSourceError>;
  readonly getById: (
    providerId: string
  ) => Effect.Effect<CanonicalEntry | undefined, CanonicalSourceError>;
  readonly writeProgress: (
    progress: CanonicalProgress
  ) => Effect.Effect<void, CanonicalSourceError>;
}

export interface CanonicalSearchSource {
  readonly provider: Exclude<CanonicalProvider, "local">;
  readonly search: (
    query: string,
    options?: CanonicalSearchOptions
  ) => Effect.Effect<readonly CanonicalSearchResult[], CanonicalSourceError>;
  readonly getById: (
    providerId: string
  ) => Effect.Effect<CanonicalEntry | undefined, CanonicalSourceError>;
  readonly getByIdMal?: (
    idMal: string
  ) => Effect.Effect<CanonicalEntry | undefined, CanonicalSourceError>;
}

export const canonicalId = (
  provider: CanonicalProvider,
  providerId: string
): string => `${provider}:${providerId}`;
