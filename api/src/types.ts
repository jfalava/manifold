import type {
  AuthConnection,
  AuthProvider,
  CompleteOpsInput,
  IngestCandidateInput,
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
  RegistryEntry,
  RegistryListEntry,
  RegistrySummary,
  ResolveEntryInput,
  SetListStateInput,
  SetMangaDexStatusInput,
  SyncOp,
  UpsertEntryInput,
} from "./domain";
import type { MangaDexChapter, MangaDexPaged } from "@manifold/mangadex";
import type { Ai, SecretsStoreSecret, VectorizeIndex } from "@cloudflare/workers-types";
import type { MangaDexEntryStat } from "./mangadex-stats";
import type { OAuthStart } from "./oauth";

export type { RegistryListEntry };

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
  upsertEntry(input: UpsertEntryInput): Promise<RegistryEntry>;
  listEntries(): Promise<readonly RegistryEntry[]>;
  getEntry(entryId: string): Promise<RegistryEntry | undefined>;
  linkProvider(entryId: string, input: LinkProviderInput): Promise<RegistryEntry>;
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
  entryByProvider(provider: string, externalId: string): Promise<RegistryEntry | undefined>;
  resolveEntry(input: ResolveEntryInput): Promise<RegistryEntry>;
  resolveEntries(
    input: readonly ResolveEntryInput[] | ResolveEntryInput,
  ): Promise<readonly RegistryEntry[]>;
  ingestCandidate(input: IngestCandidateInput): Promise<RegistryEntry>;
  searchRegistry(query: string, limit?: number): Promise<readonly RegistryEntry[]>;
  listRegistry(limit?: number, offset?: number): Promise<readonly RegistryListEntry[]>;
  registrySummary(): Promise<RegistrySummary>;
  unlinkProvider(entryId: string, provider: string): Promise<RegistryEntry>;
  setListState(entryId: string, input: SetListStateInput): Promise<ListState>;
  getListState(entryId: string): Promise<ListState | undefined>;
  nukeEntry(entryId: string, input: NukeEntryInput): Promise<ListState | undefined>;
  listEvents(entryId: string | undefined, limit?: number): Promise<readonly ListEvent[]>;
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
  MANIFOLD_OAUTH_REDIRECT_BASE_URL: string;
  MANIFOLD_ANILIST_CLIENT_ID: string;
  MANIFOLD_MAL_CLIENT_ID: string;
  MANIFOLD_MANGADEX_CLIENT_ID: string;
  MANIFOLD_TOKEN: RuntimeSecret;
  MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: RuntimeSecret;
  MANIFOLD_ANILIST_CLIENT_SECRET: RuntimeSecret;
  MANIFOLD_MAL_CLIENT_SECRET: RuntimeSecret;
  MANIFOLD_MANGADEX_CLIENT_SECRET: RuntimeSecret;
  MANIFOLD_MANGADEX_USERNAME: RuntimeSecret;
  MANIFOLD_MANGADEX_PASSWORD: RuntimeSecret;
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}
