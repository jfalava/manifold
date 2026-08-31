import type {
  AuthConnection,
  AuthProvider,
  CanonicalEntry,
  ListEvent,
  ListState,
  MangaDexLibraryItem,
  OAuthProvider,
  ReadingProgress,
  SyncOp
} from "./domain";
import type { MangaDexChapter, MangaDexPaged } from "@manifold/mangadex";
import type { Ai, SecretsStoreSecret, VectorizeIndex } from "@cloudflare/workers-types";
import type { OAuthStart } from "./oauth";

export type RegistryListEntry = CanonicalEntry & {
  readonly state?: ListState;
  readonly tombstoned?: boolean;
};

export interface ManifoldSyncStub {
  createOAuthSession(provider: OAuthProvider, redirectUri: string): Promise<OAuthStart>;
  completeOAuthSession(
    provider: OAuthProvider,
    state: string,
    code: string
  ): Promise<AuthConnection>;
  cancelOAuthSession(provider: OAuthProvider, state: string): Promise<void>;
  loginMangaDex(): Promise<AuthConnection>;
  listAuthConnections(): Promise<readonly AuthConnection[]>;
  getAuthConnection(provider: AuthProvider): Promise<AuthConnection>;
  disconnectAuth(provider: AuthProvider): Promise<void>;
  getAuthAccessToken(provider: AuthProvider): Promise<string>;
  upsertEntry(input: unknown): Promise<CanonicalEntry>;
  listEntries(): Promise<readonly CanonicalEntry[]>;
  getEntry(entryId: string): Promise<CanonicalEntry | undefined>;
  linkProvider(entryId: string, input: unknown): Promise<CanonicalEntry>;
  getProgress(entryId: string): Promise<ReadingProgress | undefined>;
  recordRead(entryId: string, input: unknown): Promise<ReadingProgress>;
  listPendingSync(): Promise<readonly SyncOp[]>;
  retryFailedSync(): Promise<{ retried: number }>;
  backfillMangaDexShelf(): Promise<{ enqueued: number }>;
  mangaDexLibrary(status?: string): Promise<readonly MangaDexLibraryItem[]>;
  mangaDexCurrentUser(): Promise<{ id: string; name?: string }>;
  mangaDexReadMarkers(mangaDexId: string): Promise<readonly string[]>;
  mangaDexFeed(limit: number, offset: number): Promise<MangaDexPaged<MangaDexChapter>>;
  mangaDexStats(mangaDexIds: readonly string[]): Promise<Record<string, unknown>>;
  setMangaDexStatus(mangaDexId: string, input: unknown): Promise<void>;
  entryByProvider(provider: string, externalId: string): Promise<CanonicalEntry | undefined>;
  resolveEntry(input: unknown): Promise<CanonicalEntry>;
  resolveEntries(input: unknown): Promise<readonly CanonicalEntry[]>;
  listRegistry(limit?: number, offset?: number): Promise<readonly RegistryListEntry[]>;
  unlinkProvider(entryId: string, provider: string): Promise<CanonicalEntry>;
  setListState(entryId: string, input: unknown): Promise<ListState>;
  getListState(entryId: string): Promise<ListState | undefined>;
  nukeEntry(entryId: string, input: unknown): Promise<ListState | undefined>;
  listEvents(entryId: string | undefined, limit?: number): Promise<readonly ListEvent[]>;
  pendingAniListOps(limit?: number): Promise<readonly SyncOp[]>;
  completeOps(input: unknown): Promise<{ updated: number }>;
  retryOp(opId: string): Promise<SyncOp | undefined>;
  listOps(state?: string, target?: string, limit?: number): Promise<readonly SyncOp[]>;
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
