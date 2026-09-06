import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { errorMessage, isJsonObject, stringField, type JsonObject } from "@manifold/json";
import {
  createMangaDexClient,
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT,
  MANGADEX_USER_AGENT,
  type MangaDexChapter,
  type MangaDexPaged,
} from "@manifold/mangadex";
import { readSecret } from "./read-secret";
import {
  type AuthConnection,
  type AuthProvider,
  type RegistryEntry,
  type RegistryListEntry,
  type CompleteOpsInput,
  type IngestCandidateInput,
  type LinkProviderInput,
  type ListEvent,
  type ListState,
  type NukeEntryInput,
  type OAuthProvider,
  type OpKind,
  type OpOrigin,
  type OpState,
  type OpTarget,
  type ReadingProgress,
  type RecordReadInput,
  type ResolveEntryInput,
  type SetListStateInput,
  type SetMangaDexStatusInput,
  type SyncOp,
  type MangaDexLibraryItem,
  type MangaDexLibrarySummary,
  type OpsSummary,
  type RegistrySummary,
  type UpsertEntryInput,
} from "./domain";
import {
  composeMangaDexEntryStat,
  mapWithConcurrency,
  MD_STATS_CONCURRENCY,
  MD_STATS_FEED_SAMPLE,
  MD_STATS_TTL_MS,
  parseMdFeedStatsPayload,
  sampleFeedStats,
  type MangaDexEntryStat,
  type MdFeedStatsPayload,
} from "./mangadex-stats";
import { createAniListListStateOpPayload } from "./list-state-op";
import {
  createAuthorizationUrl,
  createPkceChallenge,
  createRandomValue,
  getOAuthClientConfig,
  type OAuthStart,
  type OAuthTokenResponse,
  OAuthTokenResponse as OAuthTokenResponseSchema,
} from "./oauth";
import { groupOutboxForDrain } from "./outbox-drain";
import {
  type EntryRow,
  type ListEventRow,
  type ListStateRow,
  type OAuthSessionRow,
  type OAuthTokenRow,
  type OpRow,
  type ProgressRow,
  type ProviderRow,
  shouldAdvanceProgress,
  toListEvent,
  toListState,
  toOp,
  toProgress,
  toRegistryEntry,
} from "./sync-rows";
import { decryptToken, encryptToken } from "./token-crypto";
import type { Env } from "./types";

export type { MangaDexEntryStat };

const now = () => Date.now();

const SYNC_DRAIN_LIMIT = 500;
const SYNC_RETRY_DELAY_MS = 5_000;
const SYNC_MAX_ATTEMPTS = 5;
// MangaDex status shelves are one idempotent PUT per entry; a small cap per
// alarm keeps the DO input gate closed only briefly.
const MD_STATUS_DRAIN_LIMIT = 50;

export class ManifoldSync extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async createOAuthSession(
    provider: OAuthProvider,
    redirectUri: string,
    returnPath?: string
  ): Promise<OAuthStart> {
    const config = await getOAuthClientConfig(provider, this.env);
    const state = createRandomValue();
    const codeVerifier = config.pkceMethod ? createRandomValue(48) : undefined;
    const codeChallenge = codeVerifier
      ? config.pkceMethod === "S256"
        ? await createPkceChallenge(codeVerifier)
        : codeVerifier
      : undefined;

    this.ctx.storage.sql.exec("DELETE FROM oauth_sessions WHERE created_at < ?", now() - 600_000);
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_sessions
         (provider, state, code_verifier, redirect_uri, return_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      provider,
      state,
      codeVerifier ?? null,
      redirectUri,
      returnPath ?? null,
      now()
    );

    return {
      provider,
      authorizationUrl: createAuthorizationUrl(config, redirectUri, state, codeChallenge)
    };
  }

  async completeOAuthSession(
    provider: OAuthProvider,
    state: string,
    code: string
  ): Promise<AuthConnection & { readonly returnPath?: string }> {
    const session = this.ctx.storage.sql
      .exec<OAuthSessionRow>(
        `SELECT * FROM oauth_sessions
         WHERE provider = ? AND state = ? AND created_at >= ?`,
        provider,
        state,
        now() - 600_000
      )
      .toArray()[0];

    if (!session) {throw new Error("OAuth session is invalid or expired");}

    const returnPath = session.return_path ?? undefined;

    // Consume the state before external I/O so a callback cannot be replayed.
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_sessions WHERE provider = ? AND state = ?",
      provider,
      state
    );

    const config = await getOAuthClientConfig(provider, this.env);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      redirect_uri: session.redirect_uri
    });
    if (config.clientSecret) {form.set("client_secret", config.clientSecret);}
    if (session.code_verifier) {form.set("code_verifier", session.code_verifier);}

    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    });
    if (!response.ok) {
      throw new Error(`OAuth token exchange failed for ${provider} (${response.status})`);
    }

    const token = await Effect.runPromise(
      Schema.decodeUnknownEffect(OAuthTokenResponseSchema)(await response.json())
    );
    const connection = await this.persistToken(provider, token);
    return returnPath ? { ...connection, returnPath } : connection;
  }

  async cancelOAuthSession(
    provider: OAuthProvider,
    state: string
  ): Promise<{ readonly returnPath?: string }> {
    const session = this.ctx.storage.sql
      .exec<OAuthSessionRow>(
        `SELECT return_path FROM oauth_sessions WHERE provider = ? AND state = ?`,
        provider,
        state
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_sessions WHERE provider = ? AND state = ?",
      provider,
      state
    );
    const returnPath = session?.return_path ?? undefined;
    return returnPath ? { returnPath } : {};
  }

  async loginMangaDex(): Promise<AuthConnection> {
    const response = await fetch(MANGADEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": MANGADEX_USER_AGENT
      },
      body: createMangaDexPasswordGrant({
        clientId: this.env.MANIFOLD_MANGADEX_CLIENT_ID,
        clientSecret: await readSecret(this.env.MANIFOLD_MANGADEX_CLIENT_SECRET, "MANIFOLD_MANGADEX_CLIENT_SECRET"),
        username: await readSecret(this.env.MANIFOLD_MANGADEX_USERNAME, "MANIFOLD_MANGADEX_USERNAME"),
        password: await readSecret(this.env.MANIFOLD_MANGADEX_PASSWORD, "MANIFOLD_MANGADEX_PASSWORD")
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new Error(
        `MangaDex login failed (${response.status})` + (detail ? `: ${detail}` : "")
      );
    }

    const token = await Effect.runPromise(
      Schema.decodeUnknownEffect(OAuthTokenResponseSchema)(await response.json())
    );
    const connection = await this.persistToken("mangadex", token);
    this.ctx.storage.sql.exec(
      `UPDATE sync_ops
       SET state = 'pending', attempts = 0, updated_at = ?
       WHERE target = 'mangadex' AND state IN ('failed', 'blocked')`,
      now()
    );
    try {
      await this.scheduleSync();
    } catch (error) {
      console.error(`[ManifoldSync] failed to schedule MangaDex sync: ${errorMessage(error)}`);
    }
    return connection;
  }

  /**
   * Stores a bearer access token minted outside the Worker (browser implicit
   * OAuth or paste). AniList blocks Worker egress for code exchange and GraphQL;
   * the DO still needs the encrypted token for device-drain coordination and
   * connection status in admin.
   */
  async importAuthToken(
    provider: AuthProvider,
    accessToken: string,
    expiresIn?: number
  ): Promise<AuthConnection> {
    const token = accessToken.trim();
    if (!token) {
      throw new Error("Access token is empty");
    }
    if (provider !== "anilist" && provider !== "mal") {
      throw new Error(`Token import is not supported for ${provider}`);
    }
    const payload: {
      readonly access_token: string;
      readonly expires_in?: number;
    } = expiresIn !== undefined && expiresIn > 0
      ? { access_token: token, expires_in: expiresIn }
      : { access_token: token };
    return this.persistToken(provider, payload);
  }

  async listAuthConnections(): Promise<readonly AuthConnection[]> {
    const providers: readonly AuthProvider[] = ["anilist", "mal", "mangadex"];
    return providers.map((provider) => this.readAuthConnection(provider));
  }

  async getAuthConnection(provider: AuthProvider): Promise<AuthConnection> {
    return this.readAuthConnection(provider);
  }

  async disconnectAuth(provider: AuthProvider): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM oauth_tokens WHERE provider = ?", provider);
  }

  async getAuthAccessToken(provider: AuthProvider): Promise<string> {
    const row = this.readAuthToken(provider);
    if (!row) {throw new Error(`Auth provider is not connected: ${provider}`);}

    if (row.expires_at === null || row.expires_at > now() + 30_000) {
      return decryptToken(this.env, row.access_token);
    }
    if (!row.refresh_token) {
      throw new Error(`Auth provider requires reauthorization: ${provider}`);
    }

    const refreshToken = await decryptToken(this.env, row.refresh_token);
    const form =
      provider === "mangadex"
        ? createMangaDexRefreshGrant(
            {
              clientId: this.env.MANIFOLD_MANGADEX_CLIENT_ID,
              clientSecret: await readSecret(
                this.env.MANIFOLD_MANGADEX_CLIENT_SECRET,
                "MANIFOLD_MANGADEX_CLIENT_SECRET"
              )
            },
            refreshToken
          )
        : await (async () => {
            const config = await getOAuthClientConfig(provider, this.env);
            const refreshForm = new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: config.clientId
            });
            if (config.clientSecret) {refreshForm.set("client_secret", config.clientSecret);}
            return refreshForm;
          })();

    const tokenEndpoint =
      provider === "mangadex"
        ? MANGADEX_TOKEN_ENDPOINT
        : (await getOAuthClientConfig(provider, this.env)).tokenEndpoint;
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...(provider === "mangadex" && { "user-agent": MANGADEX_USER_AGENT })
      },
      body: form
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new Error(
        `Auth token refresh failed for ${provider} (${response.status})` +
          (detail ? `: ${detail}` : "")
      );
    }

    const token = await Effect.runPromise(
      Schema.decodeUnknownEffect(OAuthTokenResponseSchema)(await response.json())
    );
    const timestamp = now();
    const latest = this.readAuthToken(provider);
    if (!latest || latest.updated_at !== row.updated_at) {
      if (!latest) {throw new Error(`Auth provider disconnected during refresh: ${provider}`);}
      return decryptToken(this.env, latest.access_token);
    }

    const expiresAt = token.expires_in ? timestamp + token.expires_in * 1000 : null;
    this.ctx.storage.sql.exec(
      `UPDATE oauth_tokens SET
         access_token = ?,
         refresh_token = COALESCE(?, refresh_token),
         token_type = ?,
         expires_at = ?,
         scope = ?,
         updated_at = ?
       WHERE provider = ?`,
      await encryptToken(this.env, token.access_token),
      token.refresh_token ? await encryptToken(this.env, token.refresh_token) : null,
      token.token_type ?? row.token_type,
      expiresAt,
      token.scope ?? row.scope,
      timestamp,
      provider
    );

    return token.access_token;
  }

  async upsertEntry(input: UpsertEntryInput): Promise<RegistryEntry> {
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO canonical_entries
         (id, provider, provider_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         provider_id = excluded.provider_id,
         title = excluded.title,
         updated_at = excluded.updated_at`,
      input.id,
      input.provider,
      input.providerId,
      input.title,
      timestamp,
      timestamp,
    );
    const stored = this.readEntry(input.id);
    if (!stored) {throw new Error(`Canonical entry not found after write: ${input.id}`);}
    return stored;
  }

  async listEntries(): Promise<readonly RegistryEntry[]> {
    return Effect.runSync(
      Effect.sync(() => {
        const rows = this.ctx.storage.sql
          .exec<EntryRow>("SELECT * FROM canonical_entries ORDER BY updated_at DESC")
          .toArray();
        return rows
          .map((row) => this.readEntry(row.id))
          .filter((entry): entry is RegistryEntry => entry !== undefined);
      })
    );
  }

  async getEntry(entryId: string): Promise<RegistryEntry | undefined> {
    return Effect.runSync(Effect.sync(() => this.readEntry(entryId, false)));
  }

  async getProgress(entryId: string): Promise<ReadingProgress | undefined> {
    return Effect.runSync(
      Effect.sync(() => {
        const row = this.ctx.storage.sql
          .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", entryId)
          .toArray()[0];
        return row ? toProgress(row) : undefined;
      })
    );
  }

  async recordRead(entryId: string, input: RecordReadInput): Promise<ReadingProgress> {
    const eventId = input.eventId ?? crypto.randomUUID();
    const readAt = input.readAt ?? now();
    // Resolved target may differ from the caller's entryId when a
    // tombstoned row has a live successor — never reassign the param.
    let targetEntryId = entryId;

    const corpse = this.ctx.storage.sql
      .exec<{ tombstoned_at: number | null }>(
        "SELECT tombstoned_at FROM canonical_entries WHERE id = ?",
        targetEntryId,
      )
      .toArray()[0];
    if (!corpse) {
      throw new Error(`Canonical entry not found: ${targetEntryId}`);
    }
    if (corpse.tombstoned_at !== null) {
      // Reads are sacred: a stale library binding pointing at a nuked
      // row must never lose a read. Follow any provider link to the
      // row's live successor; with none, resurrect the corpse.
      const successor = this.ctx.storage.sql
        .exec<{ entry_id: string }>(
          `SELECT pl.entry_id FROM provider_links pl
           JOIN canonical_entries ce ON ce.id = pl.entry_id
           WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL
           LIMIT 1`,
          input.provider,
          input.sourceMangaId,
        )
        .toArray()[0];
      if (successor) {
        targetEntryId = successor.entry_id;
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE canonical_entries SET tombstoned_at = NULL, updated_at = ? WHERE id = ?",
          now(),
          targetEntryId,
        );
        this.appendEvent(targetEntryId, "list.resurrect", "device", {});
      }
    }

    const providerLink = this.ctx.storage.sql
      .exec<{ external_id: string }>(
        "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = ? LIMIT 1",
        targetEntryId,
        input.provider,
      )
      .toArray()[0];
    if (providerLink && providerLink.external_id !== input.sourceMangaId) {
      throw new Error(
        `Registry entry ${targetEntryId} has ${input.provider}:${providerLink.external_id}, not ${input.sourceMangaId}`,
      );
    }
    if (!providerLink) {
      const owner = this.ctx.storage.sql
        .exec<{ entry_id: string }>(
          "SELECT entry_id FROM provider_links WHERE provider = ? AND external_id = ? LIMIT 1",
          input.provider,
          input.sourceMangaId,
        )
        .toArray()[0];
      if (owner && owner.entry_id !== targetEntryId) {
        throw new Error(
          `${input.provider}:${input.sourceMangaId} belongs to registry entry ${owner.entry_id}`,
        );
      }
      const timestamp = now();
      this.ctx.storage.sql.exec(
        `INSERT INTO provider_links
           (entry_id, provider, external_id, title, updated_at)
         VALUES (?, ?, ?, NULL, ?)`,
        targetEntryId,
        input.provider,
        input.sourceMangaId,
        timestamp,
      );
      this.ctx.storage.sql.exec(
        "UPDATE canonical_entries SET updated_at = ? WHERE id = ?",
        timestamp,
        targetEntryId,
      );
      this.appendEvent(targetEntryId, "link.observed", "device", {
        provider: input.provider,
        externalId: input.sourceMangaId,
      });
    }

    const existingEvent = this.ctx.storage.sql
      .exec<{ entry_id: string }>("SELECT entry_id FROM read_events WHERE event_id = ?", eventId)
      .toArray()[0];

    if (existingEvent) {
      if (existingEvent.entry_id !== targetEntryId) {
        throw new Error(`Read event ${eventId} belongs to another entry`);
      }
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO read_events
           (event_id, entry_id, chapter_key, read_at)
         VALUES (?, ?, ?, ?)`,
        eventId,
        targetEntryId,
        input.chapterKey,
        readAt,
      );

      const current = this.ctx.storage.sql
        .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", targetEntryId)
        .toArray()[0];
      if (shouldAdvanceProgress(current, input.chapterNumber, readAt)) {
        const nextVersion = (current?.version ?? 0) + 1;
        this.ctx.storage.sql.exec(
          `INSERT INTO progress_state
             (entry_id, chapter_key, chapter_number, volume_number, provider,
              source_chapter_id, read_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(entry_id) DO UPDATE SET
             chapter_key = excluded.chapter_key,
             chapter_number = excluded.chapter_number,
             volume_number = excluded.volume_number,
             provider = excluded.provider,
             source_chapter_id = excluded.source_chapter_id,
             read_at = excluded.read_at,
             version = excluded.version`,
          targetEntryId,
          input.chapterKey,
          input.chapterNumber ?? null,
          input.volumeNumber ?? null,
          input.provider ?? null,
          input.sourceChapterId ?? null,
          readAt,
          nextVersion,
        );
      }

      if (input.provider === "mangadex" && input.sourceChapterId) {
        const payload: JsonObject = {
          entryId: targetEntryId,
          chapterKey: input.chapterKey,
          eventId,
          readAt,
          ...(input.chapterNumber !== undefined && { chapterNumber: input.chapterNumber }),
          ...(input.volumeNumber !== undefined && { volumeNumber: input.volumeNumber }),
          provider: input.provider,
          sourceChapterId: input.sourceChapterId,
        };
        this.enqueueOp({
          opId: eventId,
          target: "mangadex",
          kind: "mangadex.read",
          origin: "device",
          payload,
        });
      }

      // Shelf mirror: any chapter read (MangaDex or Comix fallback) on a
      // title that has a MangaDex provider link but is not yet on the
      // user's MangaDex library should appear there as "reading".
      // Copyrighted titles without an MD link are skipped — nothing to
      // mark. Deduplicated by primary key until drained.
      const mdLink = this.ctx.storage.sql
        .exec<{ external_id: string }>(
          "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'mangadex' LIMIT 1",
          targetEntryId,
        )
        .toArray()[0];
      if (mdLink) {
        this.ctx.storage.sql.exec(
          `INSERT INTO md_status_queue (entry_id, created_at, attempts)
           VALUES (?, ?, 0)
           ON CONFLICT(entry_id) DO NOTHING`,
          targetEntryId,
          now(),
        );
      }
    }

    const progress = this.getProgressSync(targetEntryId);
    if (!progress) {
      throw new Error(`Progress was not written for entry ${targetEntryId}`);
    }
    try {
      await this.scheduleSync();
    } catch (error) {
      console.error(`[ManifoldSync] failed to schedule MangaDex sync: ${errorMessage(error)}`);
    }
    return progress;
  }

  async listPendingSync(): Promise<readonly SyncOp[]> {
    return Effect.runSync(
      Effect.sync(() => this.readOps("mangadex", "pending"))
    );
  }

  // Library snapshot cache: statuses only change through setMangaDexStatus
  // (this DO) or manual MangaDex edits, so a short TTL is safe and keeps the
  // admin page from re-fetching ~26 upstream batches on every load.
  private mdLibraryCache?: { at: number; data: readonly MangaDexLibraryItem[] };
  private static readonly MD_LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Per-manga reading stats for the admin library page: the newest listed
   * chapter plus how much of that listing the user has marked read.
   *
   * Feed metadata (totalListed / latestChapter / latestPublishedAt and the
   * id→number mapping for up to 500 recent chapters) is cached per manga for
   * a day — it only changes when scanlations upload. Read markers are always
   * fetched fresh because they change while the user reads.
   */
  async mangaDexStats(
    mangaDexIds: readonly string[],
  ): Promise<Record<string, MangaDexEntryStat>> {
    const wanted = [...new Set(mangaDexIds)]
      .filter((id) => id.length > 0)
      .slice(0, 200);
    if (wanted.length === 0) {return {};}

    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });

    // 1. Feed metadata from cache, upstream sweep only for stale ids.
    const meta = new Map<string, MdFeedStatsPayload>();
    const staleIds: string[] = [];
    const cutoff = now() - MD_STATS_TTL_MS;
    for (let index = 0; index < wanted.length; index += 100) {
      const chunk = wanted.slice(index, index + 100);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.ctx.storage.sql
        .exec<{ manga_id: string; payload: string; computed_at: number }>(
          `SELECT manga_id, payload, computed_at FROM md_feed_stats WHERE manga_id IN (${placeholders})`,
          ...chunk,
        )
        .toArray();
      const fresh = new Set<string>();
      for (const row of rows) {
        if (row.computed_at < cutoff) {continue;}
        const payload = parseMdFeedStatsPayload(row.payload);
        if (!payload) {continue;}
        meta.set(row.manga_id, payload);
        fresh.add(row.manga_id);
      }
      for (const mangaDexId of chunk) {
        if (!fresh.has(mangaDexId)) {staleIds.push(mangaDexId);}
      }
    }

    const fetched = new Map<string, MdFeedStatsPayload>();
    await mapWithConcurrency(staleIds, MD_STATS_CONCURRENCY, async (mangaDexId) => {
      try {
        const page = await Effect.runPromise(
          client.feedChapters(mangaDexId, { limit: MD_STATS_FEED_SAMPLE }),
        );
        fetched.set(mangaDexId, sampleFeedStats(page));
      } catch {
        // One failed lookup must not kill the batch — its cells stay "—".
      }
    });
    for (const [mangaDexId, payload] of fetched) {
      this.ctx.storage.sql.exec(
        `INSERT INTO md_feed_stats (manga_id, payload, computed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(manga_id) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at`,
        mangaDexId,
        JSON.stringify(payload),
        now(),
      );
      meta.set(mangaDexId, payload);
    }

    // 2. Fresh read markers (grouped by manga, batched 100 ids per call).
    const readMarkers = new Map<string, ReadonlySet<string>>();
    const markerFailures = new Set<string>();
    for (let index = 0; index < wanted.length; index += 100) {
      const chunk = wanted.slice(index, index + 100);
      try {
        const grouped = await Effect.runPromise(client.readMarkersBulk(chunk));
        for (const [mangaId, ids] of Object.entries(grouped)) {
          readMarkers.set(mangaId, new Set(ids));
        }
      } catch {
        for (const mangaId of chunk) {markerFailures.add(mangaId);}
      }
    }

    // 3. Compose.
    const stats: Record<string, MangaDexEntryStat> = {};
    for (const mangaDexId of wanted) {
      stats[mangaDexId] = composeMangaDexEntryStat(
        meta.get(mangaDexId),
        readMarkers.get(mangaDexId),
        markerFailures.has(mangaDexId),
      );
    }
    return stats;
  }

  async mangaDexLibrary(status?: string): Promise<readonly MangaDexLibraryItem[]> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    const statusFilter =
      status === "reading" ||
      status === "on_hold" ||
      status === "plan_to_read" ||
      status === "dropped" ||
      status === "re_reading" ||
      status === "completed"
        ? status
        : undefined;

    // Helper to attach fresh ratings to a base library snapshot (statuses +
    // titles + covers). Ratings are always fetched live so the "has rating"
    // badge never goes stale inside the 24h library cache.
    const attachRatings = async (
      base: readonly MangaDexLibraryItem[],
    ): Promise<readonly MangaDexLibraryItem[]> => {
      if (base.length === 0) {return base;}
      const ids = base.map((row) => row.mangaDexId);
      try {
        const batch = await Effect.runPromise(client.getRatings(ids));
        const byId = new Map(Object.entries(batch));
        return base.map((row) =>
          byId.has(row.mangaDexId)
            ? {
                ...row,
                hasRating: true as const,
                rating: byId.get(row.mangaDexId)!.rating,
                ratingCreatedAt: byId.get(row.mangaDexId)!.createdAt,
              }
            : { ...row, hasRating: false as const },
        );
      } catch {
        // Best-effort — a single upstream failure must not kill the library.
        return base;
      }
    };

    const hydrate = async (
      statuses: Readonly<Record<string, string>>,
      options?: { readonly seed?: readonly MangaDexLibraryItem[] },
    ): Promise<readonly MangaDexLibraryItem[]> => {
      const mangaDexIds = Object.keys(statuses);
      const seedById = new Map((options?.seed ?? []).map((row) => [row.mangaDexId, row]));
      const links = new Map<string, string>();
      for (let index = 0; index < mangaDexIds.length; index += 100) {
        const chunk = mangaDexIds.slice(index, index + 100);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = this.ctx.storage.sql
          .exec<{ external_id: string; entry_id: string }>(
            `SELECT external_id, entry_id FROM provider_links
             WHERE provider = 'mangadex' AND external_id IN (${placeholders})`,
            ...chunk,
          )
          .toArray();
        for (const row of rows) {links.set(row.external_id, row.entry_id);}
      }
      // Resolve titles + covers in batches so the admin UI shows names, not bare UUIDs.
      // Prefer seed/cache rows; listManga only for ids still missing a title or cover.
      // listManga defaults to all content ratings (safe/suggestive/erotica/pornographic)
      // so adult titles never stay as “untitled” placeholders.
      const titles = new Map<string, string>();
      const covers = new Map<string, string>();
      const missingMeta: string[] = [];
      for (const mangaDexId of mangaDexIds) {
        const seeded = seedById.get(mangaDexId);
        if (seeded?.title) {titles.set(mangaDexId, seeded.title);}
        if (seeded?.coverUrl) {covers.set(mangaDexId, seeded.coverUrl);}
        if (!titles.has(mangaDexId) || !covers.has(mangaDexId)) {
          missingMeta.push(mangaDexId);
        }
      }
      for (let index = 0; index < missingMeta.length; index += 100) {
        const chunk = missingMeta.slice(index, index + 100);
        try {
          const page = await Effect.runPromise(client.listManga({ ids: chunk, limit: 100 }));
          for (const manga of page.items) {
            if (manga.title) {titles.set(manga.id, manga.title);}
            if (manga.coverUrl) {covers.set(manga.id, manga.coverUrl);}
          }
        } catch {
          // Titles are cosmetic here — a failed batch must not kill the list.
        }
      }
      const base: readonly MangaDexLibraryItem[] = mangaDexIds.map((mangaDexId) => ({
        mangaDexId,
        status: statuses[mangaDexId] ?? "",
        entryId: links.get(mangaDexId) ?? seedById.get(mangaDexId)?.entryId ?? null,
        ...(titles.has(mangaDexId) && { title: titles.get(mangaDexId) }),
        ...(covers.has(mangaDexId) && { coverUrl: covers.get(mangaDexId) }),
      }));
      return attachRatings(base);
    };

    // Status-scoped refresh: hydrate only that shelf. Reuse DO cache titles/covers
    // so listManga only runs for brand-new ids. Orphans that left the shelf are
    // reconciled in the admin IndexedDB merge (cleared to unset until Refresh all).
    if (statusFilter !== undefined) {
      const shelfStatuses = await Effect.runPromise(
        client.readingStatuses({ status: statusFilter }),
      );
      const library = await hydrate(shelfStatuses, { seed: this.mdLibraryCache?.data });
      if (this.mdLibraryCache) {
        const byId = new Map(library.map((row) => [row.mangaDexId, row]));
        this.mdLibraryCache = {
          at: this.mdLibraryCache.at,
          data: this.mdLibraryCache.data.map((row) => {
            const hydrated = byId.get(row.mangaDexId);
            if (hydrated) {return hydrated;}
            if ((row.status || "") === statusFilter) {return { ...row, status: "" };}
            return row;
          }),
        };
      }
      return library;
    }

    // Serve from cache when fresh, but still refresh ratings live.
    if (
      this.mdLibraryCache &&
      Date.now() - this.mdLibraryCache.at < ManifoldSync.MD_LIBRARY_TTL_MS
    ) {
      const withRatings = await attachRatings(this.mdLibraryCache.data);
      // Keep the cached snapshot in sync with the freshest ratings so a
      // subsequent cache hit without a rating fetch still reflects reality.
      if (withRatings !== this.mdLibraryCache.data) {
        this.mdLibraryCache = { at: this.mdLibraryCache.at, data: withRatings };
      }
      return withRatings;
    }

    const statuses = await Effect.runPromise(client.readingStatuses());
    const data = await hydrate(statuses);
    this.mdLibraryCache = { at: Date.now(), data };
    return data;
  }

  /**
   * Compact MangaDex shelf metrics for the admin Overview.
   * Uses readingStatuses + ratings + local link lookups only — never listManga
   * batches — so a cold Overview stays fast even on a large personal library.
   * Reuses mdLibraryCache when fresh so a prior full library load still wins.
   */
  async mangaDexLibrarySummary(): Promise<MangaDexLibrarySummary> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });

    // Prefer the hydrated library cache when fresh — Overview then avoids any
    // upstream round-trip beyond what a prior full load already paid.
    if (
      this.mdLibraryCache &&
      Date.now() - this.mdLibraryCache.at < ManifoldSync.MD_LIBRARY_TTL_MS
    ) {
      const data = this.mdLibraryCache.data;
      const statusCounts = new Map<string, number>();
      let rated = 0;
      let ratingSum = 0;
      let linkedToRegistry = 0;
      let sawRatingFlag = false;
      for (const row of data) {
        const status = row.status === "" ? "unset" : row.status;
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
        if (row.hasRating !== undefined) {
          sawRatingFlag = true;
        }
        if (row.hasRating === true && row.rating !== undefined) {
          rated += 1;
          ratingSum += row.rating;
        }
        if (row.entryId !== null) {
          linkedToRegistry += 1;
        }
      }
      if (!sawRatingFlag && data.length > 0) {
        try {
          const batch = await Effect.runPromise(
            client.getRatings(data.map((row) => row.mangaDexId)),
          );
          rated = 0;
          ratingSum = 0;
          for (const entry of Object.values(batch)) {
            rated += 1;
            ratingSum += entry.rating;
          }
        } catch {
          // Best-effort ratings for overview.
        }
      }
      return {
        total: data.length,
        statuses: Object.fromEntries(statusCounts),
        rated,
        meanRating: rated > 0 ? ratingSum / rated : null,
        linkedToRegistry,
      };
    }

    const statuses = await Effect.runPromise(client.readingStatuses());
    const mangaDexIds = Object.keys(statuses);
    const statusCounts = new Map<string, number>();
    for (const status of Object.values(statuses)) {
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }

    let rated = 0;
    let ratingSum = 0;
    try {
      const batch = await Effect.runPromise(client.getRatings(mangaDexIds));
      for (const entry of Object.values(batch)) {
        rated += 1;
        ratingSum += entry.rating;
      }
    } catch {
      // Best-effort — overview still works without mean rating.
    }

    let linkedToRegistry = 0;
    for (let index = 0; index < mangaDexIds.length; index += 100) {
      const chunk = mangaDexIds.slice(index, index + 100);
      if (chunk.length === 0) {
        continue;
      }
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.ctx.storage.sql
        .exec<{ external_id: string }>(
          `SELECT external_id FROM provider_links
           WHERE provider = 'mangadex' AND external_id IN (${placeholders})`,
          ...chunk,
        )
        .toArray();
      linkedToRegistry += rows.length;
    }

    return {
      total: mangaDexIds.length,
      statuses: Object.fromEntries(statusCounts),
      rated,
      meanRating: rated > 0 ? ratingSum / rated : null,
      linkedToRegistry,
    };
  }

  async mangaDexFeed(
    limit: number,
    offset: number,
  ): Promise<MangaDexPaged<MangaDexChapter>> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    return Effect.runPromise(client.followedFeed({ limit, offset }));
  }

  async setMangaDexStatus(mangaDexId: string, input: SetMangaDexStatusInput): Promise<void> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    await Effect.runPromise(client.updateReadingStatus(mangaDexId, input.status));
    this.mdLibraryCache = undefined;
  }

  async entryByProvider(provider: string, externalId: string): Promise<RegistryEntry | undefined> {
    return Effect.runSync(
      Effect.sync(() => {
        const row = this.ctx.storage.sql
          .exec<{ entry_id: string }>(
            `SELECT pl.entry_id FROM provider_links pl
             JOIN canonical_entries ce ON ce.id = pl.entry_id
             WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL`,
            provider,
            externalId,
          )
          .toArray()[0];
        return row ? this.readEntry(row.entry_id, false) : undefined;
      }),
    );
  }

  async mangaDexCurrentUser(): Promise<{ id: string; name?: string }> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    return Effect.runPromise(client.currentUser());
  }

  async mangaDexReadMarkers(mangaDexId: string): Promise<readonly string[]> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    return Effect.runPromise(client.readMarkers(mangaDexId));
  }

  async retryFailedSync(): Promise<{ retried: number }> {
    this.ctx.storage.sql.exec(
      `UPDATE sync_ops SET state = 'pending', attempts = 0, updated_at = ?
       WHERE target = 'mangadex' AND state IN ('failed', 'blocked')`,
      now()
    );
    const pending = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_ops WHERE state = 'pending' AND target = 'mangadex'"
      )
      .toArray()[0]?.count ?? 0;
    await this.scheduleSync();
    return { retried: pending };
  }

  // ------------------------------------------------------------------
  // Registry: provider-neutral entries keyed by minted UUIDs.
  // ------------------------------------------------------------------

  async resolveEntry(input: ResolveEntryInput): Promise<RegistryEntry> {
    return this.resolveEntrySync(input);
  }

  async resolveEntries(
    input: readonly ResolveEntryInput[] | ResolveEntryInput,
  ): Promise<readonly RegistryEntry[]> {
    const requests = Array.isArray(input) ? input : [input];
    return requests.map((request) => this.resolveEntrySync(request));
  }

  async ingestCandidate(input: IngestCandidateInput): Promise<RegistryEntry> {
    const byProvider = new Map<string, LinkProviderInput>();
    for (const link of [
      {
        provider: input.provider,
        externalId: input.providerId,
        title: input.title,
      },
      ...(input.links ?? []),
    ]) {
      const existing = byProvider.get(link.provider);
      if (existing && existing.externalId !== link.externalId) {
        throw new Error(
          `Registry candidate has conflicting ${link.provider} ids: ` +
            `${existing.externalId} and ${link.externalId}`,
        );
      }
      byProvider.set(link.provider, link);
    }
    const links = [...byProvider.values()];
    const matchingEntryIds = new Set<string>();
    for (const link of links) {
      for (const row of this.ctx.storage.sql
        .exec<{ entry_id: string }>(
          `SELECT pl.entry_id FROM provider_links pl
           JOIN canonical_entries ce ON ce.id = pl.entry_id
           WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL`,
          link.provider,
          link.externalId,
        )
        .toArray()) {
        matchingEntryIds.add(row.entry_id);
      }
    }
    if (matchingEntryIds.size > 1) {
      throw new Error(
        `Registry candidate links belong to multiple entries: ${[...matchingEntryIds].join(", ")}`,
      );
    }

    const timestamp = now();
    const matchedId = [...matchingEntryIds][0];
    const entryId = matchedId ?? crypto.randomUUID();
    if (matchedId) {
      const existingLinks = this.ctx.storage.sql
        .exec<ProviderRow>(
          "SELECT provider, external_id, title, updated_at FROM provider_links WHERE entry_id = ?",
          entryId,
        )
        .toArray();
      const existingByProvider = new Map(existingLinks.map((link) => [link.provider, link]));
      for (const link of links) {
        const existing = existingByProvider.get(link.provider);
        if (existing && existing.external_id !== link.externalId) {
          throw new Error(
            `Registry entry ${entryId} already has ${link.provider}:${existing.external_id}`,
          );
        }
      }
      this.ctx.storage.sql.exec(
        "UPDATE canonical_entries SET updated_at = ? WHERE id = ?",
        timestamp,
        entryId,
      );
    } else {
      const mintProvider =
        input.provider === "anilist" || input.provider === "mal" ? input.provider : "local";
      this.ctx.storage.sql.exec(
        `INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        entryId,
        mintProvider,
        input.providerId,
        input.title,
        timestamp,
        timestamp,
      );
    }

    for (const link of links) {
      this.ctx.storage.sql.exec(
        `INSERT INTO provider_links (entry_id, provider, external_id, title, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entry_id, provider) DO UPDATE SET
           title = COALESCE(excluded.title, provider_links.title),
           updated_at = excluded.updated_at`,
        entryId,
        link.provider,
        link.externalId,
        link.title ?? null,
        timestamp,
      );
    }
    this.appendEvent(entryId, "candidate.ingest", "device", {
      provider: input.provider,
      providerId: input.providerId,
      linkedProviders: links.map((link) => link.provider),
    });
    const entry = this.readEntry(entryId);
    if (!entry) {throw new Error(`Registry row not found after candidate ingest: ${entryId}`);}
    return entry;
  }

  private resolveEntrySync(request: ResolveEntryInput): RegistryEntry {
    const timestamp = now();
    // Tombstoned rows are dead lifecycles: a nuked title coming back gets a
    // fresh registry row, never the corpse. History stays in the admin view.
    const existing = this.ctx.storage.sql
      .exec<{ entry_id: string }>(
        `SELECT pl.entry_id FROM provider_links pl
         JOIN canonical_entries ce ON ce.id = pl.entry_id
         WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL`,
        request.provider,
        request.providerId
      )
      .toArray()[0];
    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE canonical_entries SET title = ?, updated_at = ? WHERE id = ? AND title <> ?",
        request.title,
        timestamp,
        existing.entry_id,
        request.title
      );
      const entry = this.readEntry(existing.entry_id, false);
      if (!entry) {throw new Error(`Registry row vanished for link: ${existing.entry_id}`);}
      return entry;
    }

    const id = crypto.randomUUID();
    // canonical_entries.provider is CanonicalProvider (anilist|mal|local). Content
    // providers (mangadex/comix) only live on provider_links — mint source stays local.
    const mintProvider =
      request.provider === "anilist" || request.provider === "mal" ? request.provider : "local";
    this.ctx.storage.sql.exec(
      `INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      mintProvider,
      request.providerId,
      request.title,
      timestamp,
      timestamp
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO provider_links (entry_id, provider, external_id, title, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      request.provider,
      request.providerId,
      request.title,
      timestamp
    );

    const minted = this.readEntry(id);
    if (!minted) {throw new Error(`Registry row not found after mint: ${id}`);}
    return minted;
  }

  async searchRegistry(query: string, limit = 25): Promise<readonly RegistryEntry[]> {
    const normalized = query.trim();
    if (!normalized) {return [];}
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const escaped = normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern = `%${escaped}%`;
    const rows = this.ctx.storage.sql
      .exec<EntryRow>(
        `SELECT DISTINCT ce.* FROM canonical_entries ce
         LEFT JOIN provider_links pl ON pl.entry_id = ce.id
         WHERE ce.tombstoned_at IS NULL
           AND (ce.title LIKE ? ESCAPE '\\' OR pl.title LIKE ? ESCAPE '\\')
         ORDER BY CASE WHEN lower(ce.title) = lower(?) THEN 0 ELSE 1 END,
                  ce.updated_at DESC
         LIMIT ?`,
        pattern,
        pattern,
        normalized,
        safeLimit,
      )
      .toArray();
    return rows.flatMap((row) => {
      const entry = this.readEntry(row.id, false);
      return entry ? [entry] : [];
    });
  }

  async listRegistry(limit = 500, offset = 0): Promise<readonly RegistryListEntry[]> {
    const safeLimit = Math.min(5000, Math.max(1, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    return Effect.runSync(
      Effect.sync(() => {
        const results: (RegistryEntry & {
          state?: ListState;
          progress?: ReadingProgress;
          tombstoned?: boolean;
        })[] = [];
        for (const row of this.ctx.storage.sql
          .exec<EntryRow>(
            "SELECT * FROM canonical_entries ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
            safeLimit,
            safeOffset,
          )
          .toArray()) {
          const entry = this.readEntry(row.id, false);
          if (!entry) {continue;}
          const state = this.readListState(row.id);
          const progress = this.getProgressSync(row.id);
          results.push({
            ...entry,
            ...(state && { state }),
            ...(progress && { progress }),
            ...(row.tombstoned_at !== null && { tombstoned: true })
          });
        }
        return results;
      })
    );
  }

  /**
   * SQL aggregates for the admin Overview — avoids paging every registry entry
   * over the admin↔API hop just to count statuses and provider coverage.
   */
  async registrySummary(): Promise<RegistrySummary> {
    return Effect.runSync(
      Effect.sync(() => {
        const total =
          this.ctx.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM canonical_entries")
            .toArray()[0]?.count ?? 0;
        const tombstoned =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM canonical_entries WHERE tombstoned_at IS NOT NULL",
            )
            .toArray()[0]?.count ?? 0;
        const active = total - tombstoned;

        const statusRows = this.ctx.storage.sql
          .exec<{ status: string | null; count: number }>(
            `SELECT ls.status AS status, COUNT(*) AS count
             FROM canonical_entries ce
             LEFT JOIN list_state ls ON ls.entry_id = ce.id
             WHERE ce.tombstoned_at IS NULL
             GROUP BY ls.status`,
          )
          .toArray();
        const statuses: Record<string, number> = {};
        for (const row of statusRows) {
          const key = row.status && row.status.length > 0 ? row.status : "unset";
          statuses[key] = (statuses[key] ?? 0) + row.count;
        }

        const providerRows = this.ctx.storage.sql
          .exec<{ provider: string; count: number }>(
            `SELECT pl.provider AS provider, COUNT(DISTINCT pl.entry_id) AS count
             FROM provider_links pl
             JOIN canonical_entries ce ON ce.id = pl.entry_id
             WHERE ce.tombstoned_at IS NULL
             GROUP BY pl.provider`,
          )
          .toArray();
        const providerCounts: Record<string, number> = {};
        for (const row of providerRows) {
          providerCounts[row.provider] = row.count;
        }

        const fullyLinked =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM (
                 SELECT ce.id AS id
                 FROM canonical_entries ce
                 JOIN provider_links pl ON pl.entry_id = ce.id
                 WHERE ce.tombstoned_at IS NULL
                   AND pl.provider IN ('anilist', 'mal', 'mangadex')
                 GROUP BY ce.id
                 HAVING COUNT(DISTINCT pl.provider) = 3
               ) AS fully_linked`,
            )
            .toArray()[0]?.count ?? 0;

        const unlinked =
          this.ctx.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count
               FROM canonical_entries ce
               LEFT JOIN provider_links pl ON pl.entry_id = ce.id
               WHERE ce.tombstoned_at IS NULL AND pl.entry_id IS NULL`,
            )
            .toArray()[0]?.count ?? 0;

        return {
          total,
          active,
          tombstoned,
          statuses,
          providerCounts,
          fullyLinked,
          unlinked,
        };
      }),
    );
  }

  // Binding moves the link: a provider id points at exactly one entry, so a
  // re-bind steals it from wherever it hung before.
  async linkProvider(entryId: string, input: LinkProviderInput): Promise<RegistryEntry> {
    const timestamp = now();
    this.requireEntry(entryId);
    const stolen = this.ctx.storage.sql
      .exec<{ entry_id: string }>(
        "SELECT entry_id FROM provider_links WHERE provider = ? AND external_id = ? AND entry_id <> ?",
        input.provider,
        input.externalId,
        entryId,
      )
      .toArray()[0];
    if (stolen) {
      this.ctx.storage.sql.exec(
        "DELETE FROM provider_links WHERE entry_id = ? AND provider = ?",
        stolen.entry_id,
        input.provider,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO provider_links
         (entry_id, provider, external_id, title, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entry_id, provider) DO UPDATE SET
         external_id = excluded.external_id,
         title = excluded.title,
         updated_at = excluded.updated_at`,
      entryId,
      input.provider,
      input.externalId,
      input.title ?? null,
      timestamp,
    );
    this.appendEvent(entryId, "link.set", "admin", {
      provider: input.provider,
      externalId: input.externalId,
    });
    const stored = this.readEntry(entryId);
    if (!stored) {throw new Error(`Canonical entry not found after link: ${entryId}`);}
    return stored;
  }

  async unlinkProvider(entryId: string, provider: string): Promise<RegistryEntry> {
    this.requireEntry(entryId);
    this.ctx.storage.sql.exec(
      "DELETE FROM provider_links WHERE entry_id = ? AND provider = ?",
      entryId,
      provider
    );
    this.appendEvent(entryId, "link.remove", "admin", { provider });
    const stored = this.readEntry(entryId);
    if (!stored) {throw new Error(`Canonical entry not found after unlink: ${entryId}`);}
    return stored;
  }

  // ------------------------------------------------------------------
  // List state: the D1 projection of AniList list data plus go-ham fields
  // Paperback has no UI for (score, notes, dates).
  // ------------------------------------------------------------------

  async setListState(entryId: string, input: SetListStateInput): Promise<ListState> {
    const changes = input;
    this.requireEntry(entryId);
    const timestamp = now();
    const current = this.readListState(entryId);
    const anilistId = this.anilistLinkOf(entryId);

    const nextStatus =
      changes.status === undefined ? current?.status : (changes.status ?? undefined);
    const nextScore = changes.score === undefined ? current?.score : (changes.score ?? undefined);
    const nextNotes = changes.notes === undefined ? current?.notes : (changes.notes ?? undefined);
    const nextStarted =
      changes.startedAt === undefined ? current?.startedAt : (changes.startedAt ?? undefined);
    const nextCompleted =
      changes.completedAt === undefined
        ? current?.completedAt
        : (changes.completedAt ?? undefined);
    const nextVolumes =
      changes.volumeProgress === undefined
        ? current?.volumeProgress
        : (changes.volumeProgress ?? undefined);
    const mediaListEntryId = current?.mediaListEntryId;

    this.ctx.storage.sql.exec(
      `INSERT INTO list_state
         (entry_id, status, score, notes, started_at, completed_at, volume_progress,
          media_list_entry_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         status = excluded.status,
         score = excluded.score,
         notes = excluded.notes,
         started_at = excluded.started_at,
         completed_at = excluded.completed_at,
         volume_progress = excluded.volume_progress,
         media_list_entry_id = COALESCE(excluded.media_list_entry_id, list_state.media_list_entry_id),
         updated_at = excluded.updated_at`,
      entryId,
      nextStatus ?? null,
      nextScore ?? null,
      nextNotes ?? null,
      nextStarted ?? null,
      nextCompleted ?? null,
      nextVolumes ?? null,
      mediaListEntryId ?? null,
      timestamp
    );

    const origin: OpOrigin = changes.origin ?? "admin";
    const eventDetail: JsonObject = {
      ...(changes.status !== undefined && { status: changes.status }),
      ...(changes.score !== undefined && { score: changes.score }),
      ...(changes.notes !== undefined && { notes: changes.notes }),
      ...(changes.startedAt !== undefined && { startedAt: changes.startedAt }),
      ...(changes.completedAt !== undefined && { completedAt: changes.completedAt }),
      ...(changes.volumeProgress !== undefined && { volumeProgress: changes.volumeProgress }),
      ...(changes.origin !== undefined && { origin: changes.origin }),
      ...(changes.appliedRemotely !== undefined && { appliedRemotely: changes.appliedRemotely }),
    };
    this.appendEvent(entryId, "list.state", origin, eventDetail);

    // Device-originated mutations were already applied to AniList on-device;
    // everything else becomes an op the device will drain.
    if (
      !changes.appliedRemotely &&
      anilistId &&
      (changes.status !== undefined ||
        changes.score !== undefined ||
        changes.notes !== undefined ||
        changes.startedAt !== undefined ||
        changes.completedAt !== undefined ||
        changes.volumeProgress !== undefined)
    ) {
      const onlyStatus =
        changes.status !== undefined &&
        changes.score === undefined &&
        changes.notes === undefined &&
        changes.startedAt === undefined &&
        changes.completedAt === undefined &&
        changes.volumeProgress === undefined;
      this.enqueueOp({
        opId: crypto.randomUUID(),
        target: "anilist",
        kind: onlyStatus ? "anilist.status" : "anilist.fields",
        origin,
        payload: createAniListListStateOpPayload(
          entryId,
          anilistId,
          mediaListEntryId,
          changes,
        ),
      });
    }

    const stored = this.readListState(entryId);
    if (!stored) {throw new Error(`List state missing after write: ${entryId}`);}
    return stored;
  }

  async getListState(entryId: string): Promise<ListState | undefined> {
    return Effect.runSync(Effect.sync(() => this.readListState(entryId)));
  }

  // Removal is a full nuke: the AniList entry is deleted outright and the
  // registry row is tombstoned so history survives upstream.
  async nukeEntry(entryId: string, input: NukeEntryInput): Promise<ListState | undefined> {
    const origin: OpOrigin = input.origin ?? "admin";
    this.requireEntry(entryId);
    const anilistId = this.anilistLinkOf(entryId);
    const current = this.readListState(entryId);

    if (origin !== "device" && anilistId) {
      this.enqueueOp({
        opId: crypto.randomUUID(),
        target: "anilist",
        kind: "anilist.delete",
        origin,
        payload: {
          entryId,
          anilistId,
          ...(current?.mediaListEntryId !== undefined && {
            mediaListEntryId: current.mediaListEntryId,
          }),
        },
      });
    }

    const timestamp = now();
    this.ctx.storage.sql.exec(
      "UPDATE canonical_entries SET tombstoned_at = ?, updated_at = ? WHERE id = ?",
      timestamp,
      timestamp,
      entryId,
    );
    this.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", entryId);
    this.appendEvent(entryId, "list.nuke", origin, {
      ...(anilistId !== undefined && { anilistId }),
    });

    return this.readListState(entryId);
  }

  async listEvents(entryId: string | undefined, limit = 100): Promise<readonly ListEvent[]> {
    return Effect.runSync(
      Effect.sync(() => {
        const rows = (
          entryId
            ? this.ctx.storage.sql
                .exec<ListEventRow>(
                  `SELECT * FROM list_events WHERE entry_id = ? ORDER BY id DESC LIMIT ?`,
                  entryId,
                  Math.min(500, Math.max(1, limit))
                )
                .toArray()
            : this.ctx.storage.sql
                .exec<ListEventRow>(
                  `SELECT * FROM list_events ORDER BY id DESC LIMIT ?`,
                  Math.min(500, Math.max(1, limit))
                )
                .toArray()
        ).map((row) => toListEvent(row));
        return rows;
      })
    );
  }

  // ------------------------------------------------------------------
  // Op log: device-drained anilist targets.
  // ------------------------------------------------------------------

  async pendingAniListOps(limit = 25): Promise<readonly SyncOp[]> {
    return Effect.runSync(
      Effect.sync(() =>
        this.readOps("anilist", "pending", Math.min(100, Math.max(1, limit)))
      )
    );
  }

  async completeOps(input: CompleteOpsInput): Promise<{ updated: number }> {
    let updated = 0;
    const timestamp = now();
    for (const result of input.results) {
      const row = this.ctx.storage.sql
        .exec<OpRow>("SELECT * FROM sync_ops WHERE op_id = ?", result.opId)
        .toArray()[0];
      if (!row || row.state !== "pending") {continue;}
      if (result.ok) {
        this.ctx.storage.sql.exec(
          `UPDATE sync_ops SET state = 'completed', attempts = ?, updated_at = ?
           WHERE id = ?`,
          row.attempts + 1,
          timestamp,
          row.id,
        );
        if (result.mediaListEntryId !== undefined && row.target === "anilist") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.payload);
          } catch {
            parsed = undefined;
          }
          const entryId = isJsonObject(parsed) ? stringField(parsed, "entryId") : undefined;
          if (entryId) {
            this.ctx.storage.sql.exec(
              "UPDATE list_state SET media_list_entry_id = ? WHERE entry_id = ?",
              result.mediaListEntryId,
              entryId,
            );
          }
        }
      } else {
        const attempts = row.attempts + 1;
        const state: OpState = attempts >= SYNC_MAX_ATTEMPTS ? "blocked" : "pending";
        this.ctx.storage.sql.exec(
          `UPDATE sync_ops SET state = ?, attempts = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
          state,
          attempts,
          (result.error ?? "unknown drain failure").slice(0, 500),
          timestamp,
          row.id
        );
      }
      updated += 1;
    }
    return { updated };
  }

  async retryOp(opId: string): Promise<SyncOp | undefined> {
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `UPDATE sync_ops SET state = 'pending', attempts = 0, last_error = NULL, updated_at = ?
       WHERE op_id = ?`,
      timestamp,
      opId
    );
    const row = this.ctx.storage.sql
      .exec<OpRow>("SELECT * FROM sync_ops WHERE op_id = ?", opId)
      .toArray()[0];
    return row ? toOp(row) : undefined;
  }

  async listOps(state?: string, target?: string, limit = 200): Promise<readonly SyncOp[]> {
    return Effect.runSync(
      Effect.sync(() => {
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        if (state && ["pending", "completed", "failed", "blocked"].includes(state)) {
          clauses.push("state = ?");
          params.push(state);
        }
        if (target && ["mangadex", "anilist"].includes(target)) {
          clauses.push("target = ?");
          params.push(target);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(Math.min(500, Math.max(1, limit)));
        const rows = this.ctx.storage.sql
          .exec<OpRow>(`SELECT * FROM sync_ops ${where} ORDER BY id DESC LIMIT ?`, ...params)
          .toArray();
        return rows.map((row) => toOp(row));
      })
    );
  }

  /**
   * Compact outbox metrics for the admin Overview over the same recent window
   * as GET /v1/ops (newest N ops), without shipping full op payloads.
   */
  async opsSummary(limit = 200): Promise<OpsSummary> {
    return Effect.runSync(
      Effect.sync(() => {
        const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
        const rows = this.ctx.storage.sql
          .exec<{
            state: string;
            created_at: number;
            updated_at: number;
            last_error: string | null;
          }>(
            `SELECT state, created_at, updated_at, last_error
             FROM sync_ops
             ORDER BY id DESC
             LIMIT ?`,
            safeLimit,
          )
          .toArray();
        const states = new Map<string, number>();
        let oldestPendingAt: number | null = null;
        let lastFailedError: string | null = null;
        let lastFailedAt = 0;
        for (const row of rows) {
          states.set(row.state, (states.get(row.state) ?? 0) + 1);
          if (row.state === "pending" && (oldestPendingAt === null || row.created_at < oldestPendingAt)) {
            oldestPendingAt = row.created_at;
          }
          if (
            (row.state === "failed" || row.state === "blocked") &&
            row.last_error !== null &&
            row.updated_at > lastFailedAt
          ) {
            lastFailedAt = row.updated_at;
            lastFailedError = row.last_error;
          }
        }
        return {
          total: rows.length,
          states: Object.fromEntries(states),
          oldestPendingAt,
          lastFailedError,
        };
      }),
    );
  }

  /**
   * One-shot catch-up: enqueue every entry that has recorded progress and a
   * MangaDex provider link but is missing from the shelf queue. Covers reads
   * that happened before the shelf mirror shipped.
   */
  async backfillMangaDexShelf(): Promise<{ enqueued: number }> {
    const enqueued = this.ctx.storage.sql
      .exec<{ count: number }>(
        `INSERT INTO md_status_queue (entry_id, created_at, attempts)
         SELECT ps.entry_id, ?, 0
         FROM progress_state ps
         JOIN provider_links pl
           ON pl.entry_id = ps.entry_id AND pl.provider = 'mangadex'
         LEFT JOIN md_status_queue q ON q.entry_id = ps.entry_id
         WHERE q.entry_id IS NULL
         ON CONFLICT DO NOTHING`,
        now()
      ).rowsWritten ?? 0;
    await this.scheduleSync();
    return { enqueued };
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<OpRow>(
        `SELECT * FROM sync_ops
         WHERE state = 'pending' AND target = 'mangadex'
         ORDER BY id ASC
         LIMIT ${SYNC_DRAIN_LIMIT}`
      )
      .toArray();

    if (rows.length > 0) {
      await this.drainMangaDexOutbox(rows);
    }

    await this.drainMangaDexStatusQueue();

    await this.scheduleSync(SYNC_RETRY_DELAY_MS);
  }

  private async drainMangaDexOutbox(rows: readonly OpRow[]): Promise<void> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });

    // One MangaDex round-trip per manga, not per chapter: per-chapter calls
    // kept the DO input gate closed for minutes during mass-read bursts and
    // starved concurrent /read requests until clients dropped the connection.
    const { groups, invalid } = groupOutboxForDrain(
      rows.map((row) => ({ id: row.id, payload: row.payload, attempts: row.attempts }))
    );
    for (const row of invalid) {
      this.failOps([row], new Error(`Undecodable outbox payload`));
    }

    for (const group of groups) {
      try {
        const entry = await this.getEntry(group.entryId);
        const mangaDexId = entry?.providers.find(
          (provider) => provider.provider === "mangadex"
        )?.externalId;
        if (!mangaDexId) {
          throw new Error(`No MangaDex provider link for entry ${group.entryId}`);
        }
        await Effect.runPromise(client.markChaptersRead(mangaDexId, [...group.chapters]));
        for (const row of group.rows) {
          this.ctx.storage.sql.exec(
            `UPDATE sync_ops
             SET state = 'completed', attempts = ?, updated_at = ?
             WHERE id = ? AND state = 'pending'`,
            row.attempts + 1,
            now(),
            row.id
          );
        }

      } catch (error) {
        this.failOps(group.rows, error);
      }
    }
  }

  /**
   * Marks MangaDex library entries as "reading" for titles that received
   * chapter reads through this DO but are absent from the user's MangaDex
   * library (e.g. Comix-fallback reads, or reads before the title was
   * followed). Titles already on the shelf keep whatever status the user
   * chose — we never overwrite.
   */
  private async drainMangaDexStatusQueue(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ entry_id: string; attempts: number }>(
        `SELECT entry_id, attempts FROM md_status_queue
         ORDER BY created_at ASC
         LIMIT ${MD_STATUS_DRAIN_LIMIT}`
      )
      .toArray();
    if (pending.length === 0) {return;}

    try {
      const accessToken = await this.getAuthAccessToken("mangadex");
      const client = createMangaDexClient({ accessToken });
      const statuses = await Effect.runPromise(client.readingStatuses());
      const known = new Set(Object.keys(statuses));

      for (const row of pending) {
        try {
          const mdLink = this.ctx.storage.sql
            .exec<{ external_id: string }>(
              "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'mangadex' LIMIT 1",
              row.entry_id
            )
            .toArray()[0];
          if (!mdLink) {
            // Link disappeared; nothing to mirror.
            this.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", row.entry_id);
            continue;
          }
          if (!known.has(mdLink.external_id)) {
            await Effect.runPromise(client.updateReadingStatus(mdLink.external_id, "reading"));
            known.add(mdLink.external_id);

          }
          this.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", row.entry_id);
        } catch (error) {
          const attempts = row.attempts + 1;
          if (attempts >= SYNC_MAX_ATTEMPTS) {
            this.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", row.entry_id);
            console.error(
              `[ManifoldSync] MangaDex shelf mirror dropped:${row.entry_id}:attempts=${attempts}:${errorMessage(error)}`
            );
          } else {
            this.ctx.storage.sql.exec(
              "UPDATE md_status_queue SET attempts = ? WHERE entry_id = ?",
              attempts,
              row.entry_id
            );
            console.error(
              `[ManifoldSync] MangaDex shelf mirror retry:${row.entry_id}:attempt=${attempts}:${errorMessage(error)}`
            );
          }
        }
      }
    } catch (error) {
      // Token refresh or readingStatuses failed: leave the queue intact and
      // let the next alarm retry.
      console.error(`[ManifoldSync] MangaDex shelf mirror batch failed: ${errorMessage(error)}`);
    }
  }

  private failOps(rows: readonly { id: number; attempts: number }[], cause: unknown): void {
    for (const row of rows) {
      const attempt = row.attempts + 1;
      const state: OpState = attempt >= SYNC_MAX_ATTEMPTS ? "blocked" : "pending";
      this.ctx.storage.sql.exec(
        `UPDATE sync_ops
         SET state = ?, attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
        state,
        attempt,
        errorMessage(cause).slice(0, 500),
        now(),
        row.id,
      );
      console.error(
        `[ManifoldSync] op failed:${row.id}:attempt=${attempt}:` +
          `${state}:${errorMessage(cause)}`,
      );
    }
  }

  private async scheduleSync(delayMs = 0): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_ops WHERE state = 'pending' AND target = 'mangadex'"
      )
      .toArray()[0]?.count ?? 0;
    const shelfPending = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM md_status_queue")
      .toArray()[0]?.count ?? 0;
    if (pending === 0 && shelfPending === 0) {return;}

    const scheduledAt = now() + Math.max(0, delayMs);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (
      currentAlarm === null ||
      currentAlarm <= now() ||
      currentAlarm > scheduledAt
    ) {
      await this.ctx.storage.setAlarm(scheduledAt);
    }
  }

  private async persistToken(
    provider: AuthProvider,
    token: OAuthTokenResponse
  ): Promise<AuthConnection> {
    const timestamp = now();
    const encryptedAccessToken = await encryptToken(this.env, token.access_token);
    const encryptedRefreshToken = token.refresh_token
      ? await encryptToken(this.env, token.refresh_token)
      : null;
    const expiresAt = token.expires_in ? timestamp + token.expires_in * 1000 : null;

    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_tokens
         (provider, access_token, refresh_token, token_type, expires_at, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
         token_type = excluded.token_type,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
      provider,
      encryptedAccessToken,
      encryptedRefreshToken,
      token.token_type ?? "Bearer",
      expiresAt,
      token.scope ?? null,
      timestamp
    );

    return {
      provider,
      connected: true,
      ...(!(expiresAt === null) && { expiresAt }),
      updatedAt: timestamp
    };
  }

  private readAuthConnection(provider: AuthProvider): AuthConnection {
    const row = this.readAuthToken(provider);
    return {
      provider,
      connected: row !== undefined,
      ...(row?.expires_at != null && { expiresAt: row.expires_at }),
      ...(row && { updatedAt: row.updated_at })
    };
  }

  private readAuthToken(provider: AuthProvider): OAuthTokenRow | undefined {
    return this.ctx.storage.sql
      .exec<OAuthTokenRow>("SELECT * FROM oauth_tokens WHERE provider = ?", provider)
      .toArray()[0];
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS canonical_entries (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Big-bang registry: entries are provider-neutral rows keyed by a minted
    // UUID; the provider columns record the minting source only.
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE canonical_entries ADD COLUMN tombstoned_at INTEGER"
      );
    } catch {
      // Column already exists.
    }
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE canonical_entries DROP COLUMN chapter_source"
      );
    } catch {
      // Column is absent on source-free registries.
    }
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE oauth_sessions ADD COLUMN return_path TEXT"
      );
    } catch {
      // Column already exists.
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS provider_links (
        entry_id TEXT NOT NULL REFERENCES canonical_entries(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (entry_id, provider)
      );

      CREATE INDEX IF NOT EXISTS provider_links_external
        ON provider_links (provider, external_id);

      CREATE TABLE IF NOT EXISTS read_events (
        event_id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES canonical_entries(id) ON DELETE CASCADE,
        chapter_key TEXT NOT NULL,
        read_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS progress_state (
        entry_id TEXT PRIMARY KEY REFERENCES canonical_entries(id) ON DELETE CASCADE,
        chapter_key TEXT NOT NULL,
        chapter_number REAL,
        volume_number REAL,
        provider TEXT,
        source_chapter_id TEXT,
        read_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS md_status_queue (
        entry_id TEXT PRIMARY KEY REFERENCES canonical_entries(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS md_feed_stats (
        manga_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        computed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_sessions (
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        code_verifier TEXT,
        redirect_uri TEXT NOT NULL,
        return_path TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (provider, state)
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_type TEXT NOT NULL,
        expires_at INTEGER,
        scope TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS list_state (
        entry_id TEXT PRIMARY KEY REFERENCES canonical_entries(id) ON DELETE CASCADE,
        status TEXT,
        score REAL,
        notes TEXT,
        started_at TEXT,
        completed_at TEXT,
        volume_progress REAL,
        media_list_entry_id INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'device',
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sync_ops_drain
        ON sync_ops (target, state, id);

      CREATE TABLE IF NOT EXISTS list_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL REFERENCES canonical_entries(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS list_events_entry
        ON list_events (entry_id, id);

      DROP TABLE IF EXISTS update_probe_failures;
    `);
    this.migrateLegacyOutbox();
  }

  // One-shot rebuild: legacy read-only sync_outbox rows move into sync_ops as
  // device-originated mangadex.read ops. The old table is then dropped.
  private migrateLegacyOutbox(): void {
    const legacy = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'"
      )
      .toArray()[0];
    if (!legacy) {return;}
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO sync_ops
         (op_id, target, kind, origin, payload, state, attempts, last_error, created_at, updated_at)
       SELECT event_id, 'mangadex', 'mangadex.read', 'device',
              payload, status, attempts, NULL, created_at, ?
       FROM sync_outbox`,
      timestamp
    );
    this.ctx.storage.sql.exec("DROP TABLE sync_outbox");
  }

  private requireEntry(entryId: string): void {
    if (!this.readEntry(entryId, false)) {
      throw new Error(`Canonical entry not found: ${entryId}`);
    }
  }

  // ------------------------------------------------------------------
  // Private registry/op helpers.
  // ------------------------------------------------------------------

  private enqueueOp(op: {
    opId: string;
    target: OpTarget;
    kind: OpKind;
    origin: OpOrigin;
    payload: JsonObject;
  }): void {
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO sync_ops
         (op_id, target, kind, origin, payload, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(op_id) DO NOTHING`,
      op.opId,
      op.target,
      op.kind,
      op.origin,
      JSON.stringify(op.payload),
      timestamp,
      timestamp
    );
  }

  private readOps(target: OpTarget, state?: OpState, limit = SYNC_DRAIN_LIMIT): readonly SyncOp[] {
    const rows = (
      state
        ? this.ctx.storage.sql
            .exec<OpRow>(
              `SELECT * FROM sync_ops WHERE target = ? AND state = ? ORDER BY id ASC LIMIT ?`,
              target,
              state,
              limit
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<OpRow>(
              `SELECT * FROM sync_ops WHERE target = ? ORDER BY id ASC LIMIT ?`,
              target,
              limit
            )
            .toArray()
    ).map((row) => toOp(row));
    return rows;
  }

  private readListState(entryId: string): ListState | undefined {
    const row = this.ctx.storage.sql
      .exec<ListStateRow>("SELECT * FROM list_state WHERE entry_id = ?", entryId)
      .toArray()[0];
    return row ? toListState(row) : undefined;
  }

  private anilistLinkOf(entryId: string): string | undefined {
    return (
      this.ctx.storage.sql
        .exec<{ external_id: string }>(
          "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'anilist'",
          entryId
        )
        .toArray()[0]?.external_id ?? undefined
    );
  }

  private appendEvent(
    entryId: string,
    kind: string,
    origin: OpOrigin,
    detail?: JsonObject,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO list_events (entry_id, kind, origin, detail, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      entryId,
      kind,
      origin,
      detail === undefined ? null : JSON.stringify(detail),
      now()
    );
  }

  private readEntry(entryId: string, required = true): RegistryEntry | undefined {
    const row = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM canonical_entries WHERE id = ?", entryId)
      .toArray()[0];
    if (!row) {
      if (required) {throw new Error(`Canonical entry not found: ${entryId}`);}
      return undefined;
    }

    const providerRows = this.ctx.storage.sql
      .exec<ProviderRow>(
        "SELECT provider, external_id, title, updated_at FROM provider_links WHERE entry_id = ? ORDER BY provider",
        entryId
      )
      .toArray();

    return toRegistryEntry(row, providerRows);
  }

  private getProgressSync(entryId: string): ReadingProgress | undefined {
    const row = this.ctx.storage.sql
      .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", entryId)
      .toArray()[0];
    return row ? toProgress(row) : undefined;
  }
}
