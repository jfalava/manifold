import type {
  AuthConnection,
  AuthProvider,
  CanonicalEntry,
  CompleteOpsInput,
  LinkProviderInput,
  ListEvent,
  ListState,
  MangaDexLibraryItem,
  MangaDexLibrarySummary,
  NukeEntryInput,
  OpsSummary,
  OAuthProvider,
  ReadingProgress,
  RecordReadInput,
  RegistrySummary,
  ResolveEntryInput,
  SetChapterSourceInput,
  SetListStateInput,
  SetMangaDexStatusInput,
  SyncOp,
  UpdateProbeFailure,
  ReportUpdateFailuresInput,
  UpsertEntryInput,
} from "./domain";
import type { MangaDexChapter, MangaDexPaged } from "@manifold/mangadex";
import type { Ai, SecretsStoreSecret, VectorizeIndex } from "@cloudflare/workers-types";
import type { MangaDexEntryStat } from "./mangadex-stats";
import type { OAuthStart } from "./oauth";

export type RegistryListEntry = CanonicalEntry & {
  readonly state?: ListState;
  readonly tombstoned?: boolean;
};

export interface ManifoldSyncStub {
  createOAuthSession(
    provider: OAuthProvider,
    redirectUri: string,
    returnPath?: string
  ): Promise<OAuthStart>;
  completeOAuthSession(
    provider: OAuthProvider,
    state: string,
    code: string
  ): Promise<AuthConnection & { readonly returnPath?: string }>;
  cancelOAuthSession(provider: OAuthProvider, state: string): Promise<{ readonly returnPath?: string }>;
  loginMangaDex(): Promise<AuthConnection>;
  importAuthToken(
    provider: AuthProvider,
    accessToken: string,
    expiresIn?: number
  ): Promise<AuthConnection>;
  listAuthConnections(): Promise<readonly AuthConnection[]>;
  getAuthConnection(provider: AuthProvider): Promise<AuthConnection>;
  disconnectAuth(provider: AuthProvider): Promise<void>;
  getAuthAccessToken(provider: AuthProvider): Promise<string>;
  upsertEntry(input: UpsertEntryInput): Promise<CanonicalEntry>;
  listEntries(): Promise<readonly CanonicalEntry[]>;
  getEntry(entryId: string): Promise<CanonicalEntry | undefined>;
  linkProvider(entryId: string, input: LinkProviderInput): Promise<CanonicalEntry>;
  getProgress(entryId: string): Promise<ReadingProgress | undefined>;
  recordRead(entryId: string, input: RecordReadInput): Promise<ReadingProgress>;
  listPendingSync(): Promise<readonly SyncOp[]>;
  retryFailedSync(): Promise<{ retried: number }>;
  backfillMangaDexShelf(): Promise<{ enqueued: number }>;
  mangaDexLibrary(status?: string): Promise<readonly MangaDexLibraryItem[]>;
  mangaDexLibrarySummary(): Promise<MangaDexLibrarySummary>;
  mangaDexCurrentUser(): Promise<{ id: string; name?: string }>;
  mangaDexReadMarkers(mangaDexId: string): Promise<readonly string[]>;
  mangaDexFeed(limit: number, offset: number): Promise<MangaDexPaged<MangaDexChapter>>;
  mangaDexStats(mangaDexIds: readonly string[]): Promise<Record<string, MangaDexEntryStat>>;
  setMangaDexStatus(mangaDexId: string, input: SetMangaDexStatusInput): Promise<void>;
  entryByProvider(provider: string, externalId: string): Promise<CanonicalEntry | undefined>;
  resolveEntry(input: ResolveEntryInput): Promise<CanonicalEntry>;
  resolveEntries(
    input: readonly ResolveEntryInput[] | ResolveEntryInput,
  ): Promise<readonly CanonicalEntry[]>;
  listRegistry(limit?: number, offset?: number): Promise<readonly RegistryListEntry[]>;
  registrySummary(): Promise<RegistrySummary>;
  unlinkProvider(entryId: string, provider: string): Promise<CanonicalEntry>;
  setListState(entryId: string, input: SetListStateInput): Promise<ListState>;
  getListState(entryId: string): Promise<ListState | undefined>;
  setChapterSource(entryId: string, input: SetChapterSourceInput): Promise<CanonicalEntry>;
  nukeEntry(entryId: string, input: NukeEntryInput): Promise<ListState | undefined>;
  listEvents(entryId: string | undefined, limit?: number): Promise<readonly ListEvent[]>;
  reportUpdateFailures(input: ReportUpdateFailuresInput): Promise<{ recorded: number }>;
  listUpdateFailures(options?: {
    readonly source?: string;
    readonly reason?: string;
    readonly entryId?: string;
    readonly limit?: number;
  }): Promise<readonly UpdateProbeFailure[]>;
  pendingAniListOps(limit?: number): Promise<readonly SyncOp[]>;
  completeOps(input: CompleteOpsInput): Promise<{ updated: number }>;
  retryOp(opId: string): Promise<SyncOp | undefined>;
  listOps(state?: string, target?: string, limit?: number): Promise<readonly SyncOp[]>;
  opsSummary(limit?: number): Promise<OpsSummary>;
}

/** Worker binding that may be a plain string (local dev) or a Secrets Store secret. */
export type RuntimeSecret = string | SecretsStoreSecret;

export interface Env {
  AI: Ai;
  MANGADEX_INDEX: VectorizeIndex;
  MANIFOLD_SYNC: {
    getByName(name: string): ManifoldSyncStub;
  };
  ENVIRONMENT: string;
  OAUTH_REDIRECT_BASE_URL: string;
  ANILIST_CLIENT_ID: string;
  MAL_CLIENT_ID: string;
  MANGADEX_CLIENT_ID: string;
  MANIFOLD_TOKEN: RuntimeSecret;
  OAUTH_TOKEN_ENCRYPTION_SECRET: RuntimeSecret;
  ANILIST_CLIENT_SECRET: RuntimeSecret;
  MAL_CLIENT_SECRET: RuntimeSecret;
  MANGADEX_CLIENT_SECRET: RuntimeSecret;
  MANGADEX_USERNAME: RuntimeSecret;
  MANGADEX_PASSWORD: RuntimeSecret;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}
