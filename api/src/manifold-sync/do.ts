/** Cloudflare Durable Object — public methods must be async. */
/** @effect-diagnostics asyncFunction:off */
import { DurableObject } from "cloudflare:workers";
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
  OAuthProvider,
  OpsSummary,
  ReadingProgress,
  RecordReadInput,
  RegistryBackupMetadata,
  RegistryEntry,
  RegistryListEntry,
  RegistrySummary,
  ResolveEntryInput,
  SetListStateInput,
  SetMangaDexStatusInput,
  SyncOp,
  UpsertEntryInput,
} from "../domain";
import type { OAuthStart } from "../oauth";
import type { MangaDexChapter, MangaDexPaged } from "@manifold/mangadex";
import type { MangaDexEntryStat } from "../mangadex-stats";
import type { Env } from "../types";
import type { SyncHost } from "./host";
import { migrate } from "./migrate";
import {
  cancelOAuthSession,
  completeOAuthSession,
  createOAuthSession,
  disconnectAuth,
  getAuthAccessToken,
  getAuthConnection,
  importAuthToken,
  listAuthConnections,
  loginMangaDex,
} from "./auth";
import { backupRegistry, listBackups, restoreBackup, resumeRegistrySync } from "./backup";
import {
  getEntry,
  getProgress,
  linkProvider,
  listEntries,
  listRegistry,
  registrySummary,
  searchRegistry,
  unlinkProvider,
  upsertEntry,
} from "./registry-crud";
import { recordRead } from "./record-read";
import {
  entryByProvider,
  mangaDexCurrentUser,
  mangaDexFeed,
  mangaDexLibrary,
  mangaDexLibrarySummary,
  mangaDexReadMarkers,
  mangaDexStats,
  setMangaDexStatus,
} from "./mangadex-api";
import { ingestCandidate, resolveEntries, resolveEntry } from "./resolve-ingest";
import { getListState, listEvents, nukeEntry, setListState } from "./list-state";
import {
  backfillMangaDexShelf,
  completeOps,
  listOps,
  listPendingSync,
  opsSummary,
  pendingAniListOps,
  retryFailedSync,
  retryOp,
} from "./ops";
import {
  alarm as runAlarm,
  drainMangaDexStatusQueue as runDrainMangaDexStatusQueue,
  failShelfEntry as runFailShelfEntry,
} from "./drains";
import { scheduleSync as runScheduleSync } from "./schedule";

export class ManifoldSync extends DurableObject<Env> {
  /** Shared with mangadex-api via SyncHost. */
  mdLibraryCache?: { at: number; data: readonly MangaDexLibraryItem[] };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  /** Host view for free-function modules (shares mdLibraryCache on this). */
  private host(): SyncHost {
    const self = this;
    return {
      ctx: this.ctx,
      env: this.env,
      get mdLibraryCache() {
        return self.mdLibraryCache;
      },
      set mdLibraryCache(value) {
        self.mdLibraryCache = value;
      },
    };
  }

  private migrate(): void {
    migrate(this.host());
  }

  async createOAuthSession(
    provider: OAuthProvider,
    redirectUri: string,
    returnPath?: string,
  ): Promise<OAuthStart> {
    return createOAuthSession(this.host(), provider, redirectUri, returnPath);
  }

  async completeOAuthSession(
    provider: OAuthProvider,
    state: string,
    code: string,
  ): Promise<AuthConnection & { readonly returnPath?: string }> {
    return completeOAuthSession(this.host(), provider, state, code);
  }

  async cancelOAuthSession(
    provider: OAuthProvider,
    state: string,
  ): Promise<{ readonly returnPath?: string }> {
    return cancelOAuthSession(this.host(), provider, state);
  }

  async loginMangaDex(): Promise<AuthConnection> {
    return loginMangaDex(this.host());
  }

  async importAuthToken(
    provider: AuthProvider,
    accessToken: string,
    expiresIn?: number,
  ): Promise<AuthConnection> {
    return importAuthToken(this.host(), provider, accessToken, expiresIn);
  }

  async listAuthConnections(): Promise<readonly AuthConnection[]> {
    return listAuthConnections(this.host());
  }

  async getAuthConnection(provider: AuthProvider): Promise<AuthConnection> {
    return getAuthConnection(this.host(), provider);
  }

  async disconnectAuth(provider: AuthProvider): Promise<void> {
    return disconnectAuth(this.host(), provider);
  }

  async getAuthAccessToken(provider: AuthProvider): Promise<string> {
    return getAuthAccessToken(this.host(), provider);
  }

  async upsertEntry(input: UpsertEntryInput): Promise<RegistryEntry> {
    return upsertEntry(this.host(), input);
  }

  async listEntries(): Promise<readonly RegistryEntry[]> {
    return listEntries(this.host());
  }

  async backupRegistry(): Promise<RegistryBackupMetadata> {
    return backupRegistry(this.host());
  }

  async listBackups(): Promise<readonly RegistryBackupMetadata[]> {
    return listBackups(this.host());
  }

  async restoreBackup(key: string): Promise<RegistryBackupMetadata> {
    return restoreBackup(this.host(), key);
  }

  async resumeRegistrySync(): Promise<void> {
    return resumeRegistrySync(this.host());
  }

  async getEntry(entryId: string): Promise<RegistryEntry | undefined> {
    return getEntry(this.host(), entryId);
  }

  async getProgress(entryId: string): Promise<ReadingProgress | undefined> {
    return getProgress(this.host(), entryId);
  }

  async recordRead(entryId: string, input: RecordReadInput): Promise<ReadingProgress> {
    return recordRead(this.host(), entryId, input);
  }

  async listPendingSync(): Promise<readonly SyncOp[]> {
    return listPendingSync(this.host());
  }

  async mangaDexStats(mangaDexIds: readonly string[]): Promise<Record<string, MangaDexEntryStat>> {
    return mangaDexStats(this.host(), mangaDexIds);
  }

  async mangaDexLibrary(status?: string): Promise<readonly MangaDexLibraryItem[]> {
    return mangaDexLibrary(this.host(), status);
  }

  async mangaDexLibrarySummary(): Promise<MangaDexLibrarySummary> {
    return mangaDexLibrarySummary(this.host());
  }

  async mangaDexFeed(limit: number, offset: number): Promise<MangaDexPaged<MangaDexChapter>> {
    return mangaDexFeed(this.host(), limit, offset);
  }

  async setMangaDexStatus(mangaDexId: string, input: SetMangaDexStatusInput): Promise<void> {
    return setMangaDexStatus(this.host(), mangaDexId, input);
  }

  async entryByProvider(provider: string, externalId: string): Promise<RegistryEntry | undefined> {
    return entryByProvider(this.host(), provider, externalId);
  }

  async mangaDexCurrentUser(): Promise<{ id: string; name?: string }> {
    return mangaDexCurrentUser(this.host());
  }

  async mangaDexReadMarkers(mangaDexId: string): Promise<readonly string[]> {
    return mangaDexReadMarkers(this.host(), mangaDexId);
  }

  async retryFailedSync(): Promise<{ retried: number }> {
    return retryFailedSync(this.host());
  }

  async resolveEntry(input: ResolveEntryInput): Promise<RegistryEntry> {
    return resolveEntry(this.host(), input);
  }

  async resolveEntries(inputs: readonly ResolveEntryInput[]): Promise<readonly RegistryEntry[]> {
    return resolveEntries(this.host(), inputs);
  }

  async ingestCandidate(input: IngestCandidateInput): Promise<RegistryEntry> {
    return ingestCandidate(this.host(), input);
  }

  async searchRegistry(query: string, limit = 25): Promise<readonly RegistryEntry[]> {
    return searchRegistry(this.host(), query, limit);
  }

  async listRegistry(limit = 500, offset = 0): Promise<readonly RegistryListEntry[]> {
    return listRegistry(this.host(), limit, offset);
  }

  async registrySummary(): Promise<RegistrySummary> {
    return registrySummary(this.host());
  }

  async linkProvider(entryId: string, input: LinkProviderInput): Promise<RegistryEntry> {
    return linkProvider(this.host(), entryId, input);
  }

  async unlinkProvider(entryId: string, provider: string): Promise<RegistryEntry> {
    return unlinkProvider(this.host(), entryId, provider);
  }

  async setListState(entryId: string, input: SetListStateInput): Promise<ListState> {
    return setListState(this.host(), entryId, input);
  }

  async getListState(entryId: string): Promise<ListState | undefined> {
    return getListState(this.host(), entryId);
  }

  async nukeEntry(entryId: string, input: NukeEntryInput): Promise<ListState | undefined> {
    return nukeEntry(this.host(), entryId, input);
  }

  async listEvents(entryId: string | undefined, limit = 100): Promise<readonly ListEvent[]> {
    return listEvents(this.host(), entryId, limit);
  }

  async pendingAniListOps(limit = 25): Promise<readonly SyncOp[]> {
    return pendingAniListOps(this.host(), limit);
  }

  async completeOps(input: CompleteOpsInput): Promise<{ updated: number }> {
    return completeOps(this.host(), input);
  }

  async retryOp(opId: string): Promise<SyncOp | undefined> {
    return retryOp(this.host(), opId);
  }

  async listOps(state?: string, target?: string, limit = 200): Promise<readonly SyncOp[]> {
    return listOps(this.host(), state, target, limit);
  }

  async opsSummary(limit = 200): Promise<OpsSummary> {
    return opsSummary(this.host(), limit);
  }

  async backfillMangaDexShelf(): Promise<{ enqueued: number }> {
    return backfillMangaDexShelf(this.host());
  }

  async alarm(): Promise<void> {
    return runAlarm(this.host());
  }

  // --- package hooks used by Miniflare test subclasses ---

  /** @internal */
  failShelfEntry(entryId: string, attempts: number, cause: unknown): void {
    runFailShelfEntry(this.host(), entryId, attempts, cause);
  }

  /** @internal */
  async drainMangaDexStatusQueue(): Promise<void> {
    return runDrainMangaDexStatusQueue(this.host());
  }

  /** @internal */
  async scheduleSync(delayMs = 0): Promise<void> {
    return runScheduleSync(this.host(), delayMs);
  }
}
