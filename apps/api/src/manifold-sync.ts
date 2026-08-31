import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import {
  createMangaDexClient,
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT,
  MANGADEX_USER_AGENT
} from "@manifold/mangadex";
import { readSecret } from "./read-secret";
import {
  type AuthConnection,
  type AuthProvider,
  type CanonicalEntry,
  type CompleteOpsInput,
  type LinkProviderInput,
  type ListEvent,
  type ListState,
  type OAuthProvider,
  type OpKind,
  type OpOrigin,
  type OpState,
  type OpTarget,
  type ProviderLink,
  type ReadingProgress,
  type RecordReadInput,
  type ResolveEntryInput,
  type SetListStateInput,
  type SyncOp,
  type MangaDexLibraryItem,
  type UpsertEntryInput,
  CompleteOpsInput as CompleteOpsInputSchema,
  LinkProviderInput as LinkProviderInputSchema,
  RecordReadInput as RecordReadInputSchema,
  ResolveEntryInput as ResolveEntryInputSchema,
  SetListStateInput as SetListStateInputSchema,
  UpsertEntryInput as UpsertEntryInputSchema
} from "./domain";
import {
  createAuthorizationUrl,
  createPkceChallenge,
  createRandomValue,
  getOAuthClientConfig,
  type OAuthStart,
  type OAuthTokenResponse,
  OAuthTokenResponse as OAuthTokenResponseSchema
} from "./oauth";
import type { Env } from "./types";
import { groupOutboxForDrain } from "./outbox-drain";

interface EntryRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: CanonicalEntry["provider"];
  provider_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface ProviderRow extends Record<string, SqlStorageValue> {
  provider: ProviderLink["provider"];
  external_id: string;
  title: string | null;
  updated_at: number;
}

interface ProgressRow extends Record<string, SqlStorageValue> {
  entry_id: string;
  chapter_key: string;
  chapter_number: number | null;
  volume_number: number | null;
  provider: NonNullable<ReadingProgress["provider"]> | null;
  source_chapter_id: string | null;
  read_at: number;
  version: number;
}

interface OutboxRow extends Record<string, SqlStorageValue> {
  id: number;
  event_id: string;
  target: "mangadex";
  payload: string;
  status: SyncOp["state"];
  attempts: number;
  created_at: number;
}

interface OpRow extends Record<string, SqlStorageValue> {
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

interface ListStateRow extends Record<string, SqlStorageValue> {
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

interface ListEventRow extends Record<string, SqlStorageValue> {
  id: number;
  entry_id: string;
  kind: string;
  origin: OpOrigin;
  detail: string | null;
  created_at: number;
}

interface OAuthSessionRow extends Record<string, SqlStorageValue> {
  provider: OAuthProvider;
  state: string;
  code_verifier: string | null;
  redirect_uri: string;
  created_at: number;
}

interface OAuthTokenRow extends Record<string, SqlStorageValue> {
  provider: AuthProvider;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_at: number | null;
  scope: string | null;
  updated_at: number;
}

const now = () => Date.now();

const SYNC_DRAIN_LIMIT = 500;
const SYNC_RETRY_DELAY_MS = 5_000;
const SYNC_MAX_ATTEMPTS = 5;
// MangaDex status shelves are one idempotent PUT per entry; a small cap per
// alarm keeps the DO input gate closed only briefly.
const MD_STATUS_DRAIN_LIMIT = 50;

// MangaDex stats sweep: feed metadata is day-stable (scanlation uploads are
// rare relative to admin visits), read markers stay uncached.
const MD_STATS_TTL_MS = 24 * 60 * 60 * 1000;
// Upstream rate limits (~5 req/s) bound how hard we may hammer the feed sweep.
const MD_STATS_CONCURRENCY = 4;
// Feed pages cap at 500; big series rarely list more at once anyway.
const MD_STATS_FEED_SAMPLE = 500;

interface MdFeedStatsPayload {
  readonly totalListed: number;
  readonly latestChapter: number | null;
  readonly latestPublishedAt: number | null;
  /** chapter id → chapter number for the sampled feed window. */
  readonly numbersById: Readonly<Record<string, string>>;
}

export interface MangaDexEntryStat {
  readonly lastRead: number | null;
  readonly readChapters: number | null;
  readonly totalListed: number | null;
  readonly latestChapter: number | null;
  readonly latestDate: string | null;
  readonly percent: number | null;
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===";
  const binary = atob(padded.slice(0, padded.length - (padded.length % 4)));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export class ManifoldSync extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async createOAuthSession(provider: OAuthProvider, redirectUri: string): Promise<OAuthStart> {
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
         (provider, state, code_verifier, redirect_uri, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      provider,
      state,
      codeVerifier ?? null,
      redirectUri,
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
  ): Promise<AuthConnection> {
    const session = this.ctx.storage.sql
      .exec<OAuthSessionRow>(
        `SELECT * FROM oauth_sessions
         WHERE provider = ? AND state = ? AND created_at >= ?`,
        provider,
        state,
        now() - 600_000
      )
      .toArray()[0];

    if (!session) throw new Error("OAuth session is invalid or expired");

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
    if (config.clientSecret) form.set("client_secret", config.clientSecret);
    if (session.code_verifier) form.set("code_verifier", session.code_verifier);

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
    return this.persistToken(provider, token);
  }

  async cancelOAuthSession(provider: OAuthProvider, state: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_sessions WHERE provider = ? AND state = ?",
      provider,
      state
    );
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
        clientId: this.env.MANGADEX_CLIENT_ID,
        clientSecret: await readSecret(this.env.MANGADEX_CLIENT_SECRET, "MANGADEX_CLIENT_SECRET"),
        username: await readSecret(this.env.MANGADEX_USERNAME, "MANGADEX_USERNAME"),
        password: await readSecret(this.env.MANGADEX_PASSWORD, "MANGADEX_PASSWORD")
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
    if (!row) throw new Error(`Auth provider is not connected: ${provider}`);

    if (row.expires_at === null || row.expires_at > now() + 30_000) {
      return this.decryptToken(row.access_token);
    }
    if (!row.refresh_token) {
      throw new Error(`Auth provider requires reauthorization: ${provider}`);
    }

    const refreshToken = await this.decryptToken(row.refresh_token);
    const form =
      provider === "mangadex"
        ? createMangaDexRefreshGrant(
            {
              clientId: this.env.MANGADEX_CLIENT_ID,
              clientSecret: await readSecret(
                this.env.MANGADEX_CLIENT_SECRET,
                "MANGADEX_CLIENT_SECRET"
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
            if (config.clientSecret) refreshForm.set("client_secret", config.clientSecret);
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
        ...(provider === "mangadex" ? { "user-agent": MANGADEX_USER_AGENT } : {})
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
      if (!latest) throw new Error(`Auth provider disconnected during refresh: ${provider}`);
      return this.decryptToken(latest.access_token);
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
      await this.encryptToken(token.access_token),
      token.refresh_token ? await this.encryptToken(token.refresh_token) : null,
      token.token_type ?? row.token_type,
      expiresAt,
      token.scope ?? row.scope,
      timestamp,
      provider
    );

    return token.access_token;
  }

  async upsertEntry(input: unknown): Promise<CanonicalEntry> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const entry = yield* Schema.decodeUnknownEffect(UpsertEntryInputSchema)(input);
        const timestamp = now();

        yield* Effect.sync(() => {
          self.ctx.storage.sql.exec(
            `INSERT INTO canonical_entries
               (id, provider, provider_id, title, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               provider = excluded.provider,
               provider_id = excluded.provider_id,
               title = excluded.title,
               updated_at = excluded.updated_at`,
            entry.id,
            entry.provider,
            entry.providerId,
            entry.title,
            timestamp,
            timestamp
          );
        });

        return yield* Effect.sync(() => {
          const stored = self.readEntry(entry.id);
          if (!stored) throw new Error(`Canonical entry not found after write: ${entry.id}`);
          return stored;
        });
      })
    );
  }

  async listEntries(): Promise<readonly CanonicalEntry[]> {
    return Effect.runSync(
      Effect.sync(() => {
        const rows = this.ctx.storage.sql
          .exec<EntryRow>("SELECT * FROM canonical_entries ORDER BY updated_at DESC")
          .toArray();
        return rows
          .map((row) => this.readEntry(row.id))
          .filter((entry): entry is CanonicalEntry => entry !== undefined);
      })
    );
  }

  async getEntry(entryId: string): Promise<CanonicalEntry | undefined> {
    return Effect.runSync(Effect.sync(() => this.readEntry(entryId, false)));
  }

  async getProgress(entryId: string): Promise<ReadingProgress | undefined> {
    return Effect.runSync(
      Effect.sync(() => {
        const row = this.ctx.storage.sql
          .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", entryId)
          .toArray()[0];
        return row ? this.toProgress(row) : undefined;
      })
    );
  }

  async recordRead(entryId: string, input: unknown): Promise<ReadingProgress> {
    const self = this;
    const progress = await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* Schema.decodeUnknownEffect(RecordReadInputSchema)(input);
        const eventId = read.eventId ?? crypto.randomUUID();
        const readAt = read.readAt ?? now();

        yield* Effect.sync(() => {
          const corpse = self.ctx.storage.sql
            .exec<{ tombstoned_at: number | null }>(
              "SELECT tombstoned_at FROM canonical_entries WHERE id = ?",
              entryId
            )
            .toArray()[0];
          if (!corpse) {
            throw new Error(`Canonical entry not found: ${entryId}`);
          }
          if (corpse.tombstoned_at !== null) {
            // Reads are sacred: a stale library binding pointing at a nuked
            // row must never lose a read. Follow any provider link to the
            // row's live successor; with none, resurrect the corpse.
            const successor = self.ctx.storage.sql
              .exec<{ entry_id: string }>(
                `SELECT pl2.entry_id FROM provider_links pl
                 JOIN provider_links pl2
                   ON pl2.provider = pl.provider AND pl2.external_id = pl.external_id
                 JOIN canonical_entries ce ON ce.id = pl2.entry_id
                 WHERE pl.entry_id = ? AND pl2.entry_id <> ? AND ce.tombstoned_at IS NULL
                 LIMIT 1`,
                entryId,
                entryId
              )
              .toArray()[0];
            if (successor) {
              console.log(
                `[ManifoldSync] read redirected:${entryId}->${successor.entry_id}`
              );
              entryId = successor.entry_id;
            } else {
              self.ctx.storage.sql.exec(
                "UPDATE canonical_entries SET tombstoned_at = NULL, updated_at = ? WHERE id = ?",
                now(),
                entryId
              );
              self.appendEvent(entryId, "list.resurrect", "device", {});
              console.log(`[ManifoldSync] read resurrected:${entryId}`);
            }
          }

          const existingEvent = self.ctx.storage.sql
            .exec<{ entry_id: string }>("SELECT entry_id FROM read_events WHERE event_id = ?", eventId)
            .toArray()[0];

          if (existingEvent) {
            if (existingEvent.entry_id !== entryId) {
              throw new Error(`Read event ${eventId} belongs to another entry`);
            }
            return;
          }

          self.ctx.storage.sql.exec(
            `INSERT INTO read_events
               (event_id, entry_id, chapter_key, read_at)
             VALUES (?, ?, ?, ?)`,
            eventId,
            entryId,
            read.chapterKey,
            readAt
          );

          const current = self.ctx.storage.sql
            .exec<{ version: number }>("SELECT version FROM progress_state WHERE entry_id = ?", entryId)
            .toArray()[0];
          const nextVersion = (current?.version ?? 0) + 1;

          self.ctx.storage.sql.exec(
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
               version = excluded.version
             WHERE excluded.read_at >= progress_state.read_at`,
            entryId,
            read.chapterKey,
            read.chapterNumber ?? null,
            read.volumeNumber ?? null,
            read.provider ?? null,
            read.sourceChapterId ?? null,
            readAt,
            nextVersion
          );

          if (read.provider === "mangadex" && read.sourceChapterId) {
            self.enqueueOp({
              opId: eventId,
              target: "mangadex",
              kind: "mangadex.read",
              origin: "device",
              payload: { entryId, ...read, eventId, readAt }
            });
          }

          // Shelf mirror: any chapter read (MangaDex or Comix fallback) on a
          // title that has a MangaDex provider link but is not yet on the
          // user's MangaDex library should appear there as "reading".
          // Copyrighted titles without an MD link are skipped — nothing to
          // mark. Deduplicated by primary key until drained.
          const mdLink = self.ctx.storage.sql
            .exec<{ external_id: string }>(
              "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'mangadex' LIMIT 1",
              entryId
            )
            .toArray()[0];
          if (mdLink) {
            self.ctx.storage.sql.exec(
              `INSERT INTO md_status_queue (entry_id, created_at, attempts)
               VALUES (?, ?, 0)
               ON CONFLICT(entry_id) DO NOTHING`,
              entryId,
              now()
            );
          }
        });

        const progress = yield* Effect.sync(() => self.getProgressSync(entryId));
        if (!progress) {
          throw new Error(`Progress was not written for entry ${entryId}`);
        }
        return progress;
      })
    );
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
    if (wanted.length === 0) return {};

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
        if (row.computed_at < cutoff) continue;
        try {
          meta.set(row.manga_id, JSON.parse(row.payload) as MdFeedStatsPayload);
          fresh.add(row.manga_id);
        } catch {
          // Corrupt row: treat as stale below.
        }
      }
      for (const mangaDexId of chunk) {
        if (!fresh.has(mangaDexId)) staleIds.push(mangaDexId);
      }
    }

    const fetched = new Map<string, MdFeedStatsPayload>();
    await mapWithConcurrency(staleIds, MD_STATS_CONCURRENCY, async (mangaDexId) => {
      try {
        const page = await Effect.runPromise(
          client.feedChapters(mangaDexId, { limit: MD_STATS_FEED_SAMPLE }),
        );
        const newest = page.items[0];
        const payload: MdFeedStatsPayload = {
          totalListed: page.total ?? page.items.length,
          latestChapter: newest?.chapterNumber ?? null,
          latestPublishedAt: newest?.publishedAt ?? null,
          numbersById: Object.fromEntries(
            page.items.flatMap((chapter) =>
              chapter.chapterNumber === undefined
                ? []
                : [[chapter.id, String(chapter.chapterNumber)] as const],
            ),
          ),
        };
        fetched.set(mangaDexId, payload);
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
        for (const mangaId of chunk) markerFailures.add(mangaId);
      }
    }

    // 3. Compose.
    const stats: Record<string, MangaDexEntryStat> = {};
    for (const mangaDexId of wanted) {
      const feed = meta.get(mangaDexId);
      const marks = readMarkers.get(mangaDexId);
      const totalListed = feed?.totalListed ?? null;
      let lastRead: number | null = null;
      let readChapters: number | null = null;
      if (!markerFailures.has(mangaDexId)) {
        readChapters = 0;
        if (marks !== undefined && feed !== undefined) {
          for (const chapterId of marks) {
            const numberText = feed.numbersById[chapterId];
            if (numberText === undefined) continue;
            readChapters += 1;
            const parsed = Number.parseFloat(numberText);
            if (Number.isFinite(parsed) && (lastRead === null || parsed > lastRead)) {
              lastRead = parsed;
            }
          }
        }
      }
      const percent =
        totalListed !== null && totalListed > 0 && readChapters !== null
          ? Math.min(100, Math.round((readChapters / totalListed) * 100))
          : null;
      stats[mangaDexId] = {
        lastRead,
        readChapters,
        totalListed,
        latestChapter: feed?.latestChapter ?? null,
        latestDate:
          feed?.latestPublishedAt !== undefined && feed?.latestPublishedAt !== null
            ? new Date(feed.latestPublishedAt).toISOString().slice(0, 10)
            : null,
        percent,
      };
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
      if (base.length === 0) return base;
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
        for (const row of rows) links.set(row.external_id, row.entry_id);
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
        if (seeded?.title) titles.set(mangaDexId, seeded.title);
        if (seeded?.coverUrl) covers.set(mangaDexId, seeded.coverUrl);
        if (!titles.has(mangaDexId) || !covers.has(mangaDexId)) {
          missingMeta.push(mangaDexId);
        }
      }
      for (let index = 0; index < missingMeta.length; index += 100) {
        const chunk = missingMeta.slice(index, index + 100);
        try {
          const page = await Effect.runPromise(client.listManga({ ids: chunk, limit: 100 }));
          for (const manga of page.items) {
            if (manga.title) titles.set(manga.id, manga.title);
            if (manga.coverUrl) covers.set(manga.id, manga.coverUrl);
          }
        } catch {
          // Titles are cosmetic here — a failed batch must not kill the list.
        }
      }
      const base: readonly MangaDexLibraryItem[] = mangaDexIds.map((mangaDexId) => ({
        mangaDexId,
        status: statuses[mangaDexId] ?? "",
        entryId: links.get(mangaDexId) ?? seedById.get(mangaDexId)?.entryId ?? null,
        ...(titles.has(mangaDexId) ? { title: titles.get(mangaDexId) } : {}),
        ...(covers.has(mangaDexId) ? { coverUrl: covers.get(mangaDexId) } : {}),
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
            if (hydrated) return hydrated;
            if ((row.status || "") === statusFilter) return { ...row, status: "" };
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

  async mangaDexFeed(limit: number, offset: number): Promise<unknown> {
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    return Effect.runPromise(client.followedFeed({ limit, offset }));
  }

  async setMangaDexStatus(mangaDexId: string, input: unknown): Promise<void> {
    const status = (input as { status?: unknown } | null | undefined)?.status;
    if (
      status !== null &&
      status !== "reading" &&
      status !== "on_hold" &&
      status !== "plan_to_read" &&
      status !== "dropped" &&
      status !== "re_reading" &&
      status !== "completed"
    ) {
      throw new Error("Invalid MangaDex reading status");
    }
    const accessToken = await this.getAuthAccessToken("mangadex");
    const client = createMangaDexClient({ accessToken });
    await Effect.runPromise(
      client.updateReadingStatus(
        mangaDexId,
        status === null ? null : (status as Exclude<typeof status, null>),
      ),
    );
    this.mdLibraryCache = undefined;
  }

  async entryByProvider(provider: string, externalId: string): Promise<CanonicalEntry | undefined> {
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

  async resolveEntry(input: unknown): Promise<CanonicalEntry> {
    const request = await Effect.runPromise(
      Schema.decodeUnknownEffect(ResolveEntryInputSchema)(input)
    );
    return this.resolveEntrySync(request);
  }

  async resolveEntries(input: unknown): Promise<readonly CanonicalEntry[]> {
    const requests = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Array(ResolveEntryInputSchema))(input)
    );
    return requests.map((request) => this.resolveEntrySync(request));
  }

  private resolveEntrySync(request: ResolveEntryInput): CanonicalEntry {
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
      if (!entry) throw new Error(`Registry row vanished for link: ${existing.entry_id}`);
      return entry;
    }

    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      request.provider,
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
    console.log(`[ManifoldSync] registry minted:${request.provider}:${request.providerId}:${id}`);
    const minted = this.readEntry(id);
    if (!minted) throw new Error(`Registry row not found after mint: ${id}`);
    return minted;
  }

  async listRegistry(limit = 500, offset = 0): Promise<
    readonly (CanonicalEntry & { readonly state?: ListState; readonly tombstoned?: boolean })[]
  > {
    const safeLimit = Math.min(5000, Math.max(1, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    return Effect.runSync(
      Effect.sync(() => {
        const results: (CanonicalEntry & {
          state?: ListState;
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
          if (!entry) continue;
          const values = row as Record<string, SqlStorageValue>;
          const state = this.readListState(row.id);
          results.push({
            ...entry,
            ...(state ? { state } : {}),
            ...(values.tombstoned_at !== null && values.tombstoned_at !== undefined
              ? { tombstoned: true }
              : {})
          });
        }
        return results;
      })
    );
  }

  // Binding moves the link: a provider id points at exactly one entry, so a
  // re-bind steals it from wherever it hung before.
  async linkProvider(entryId: string, input: unknown): Promise<CanonicalEntry> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const link = yield* Schema.decodeUnknownEffect(LinkProviderInputSchema)(input);
        const timestamp = now();

        yield* Effect.sync(() => {
          self.requireEntry(entryId);
          const stolen = self.ctx.storage.sql
            .exec<{ entry_id: string }>(
              "SELECT entry_id FROM provider_links WHERE provider = ? AND external_id = ? AND entry_id <> ?",
              link.provider,
              link.externalId,
              entryId
            )
            .toArray()[0];
          if (stolen) {
            self.ctx.storage.sql.exec(
              "DELETE FROM provider_links WHERE entry_id = ? AND provider = ?",
              stolen.entry_id,
              link.provider
            );
            console.log(
              `[ManifoldSync] registry rebind:${link.provider}:${link.externalId}:${stolen.entry_id}->${entryId}`
            );
          }
          self.ctx.storage.sql.exec(
            `INSERT INTO provider_links
               (entry_id, provider, external_id, title, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entry_id, provider) DO UPDATE SET
               external_id = excluded.external_id,
               title = excluded.title,
               updated_at = excluded.updated_at`,
            entryId,
            link.provider,
            link.externalId,
            link.title ?? null,
            timestamp
          );
          self.appendEvent(entryId, "link.set", "admin", {
            provider: link.provider,
            externalId: link.externalId
          });
        });

        return yield* Effect.sync(() => {
          const stored = self.readEntry(entryId);
          if (!stored) throw new Error(`Canonical entry not found after link: ${entryId}`);
          return stored;
        });
      })
    );
  }

  async unlinkProvider(entryId: string, provider: string): Promise<CanonicalEntry> {
    this.requireEntry(entryId);
    this.ctx.storage.sql.exec(
      "DELETE FROM provider_links WHERE entry_id = ? AND provider = ?",
      entryId,
      provider
    );
    this.appendEvent(entryId, "link.remove", "admin", { provider });
    return this.readEntry(entryId) as CanonicalEntry;
  }

  // ------------------------------------------------------------------
  // List state: the D1 projection of AniList list data plus go-ham fields
  // Paperback has no UI for (score, notes, dates).
  // ------------------------------------------------------------------

  async setListState(entryId: string, input: unknown): Promise<ListState> {
    const changes = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Schema.decodeUnknownEffect(SetListStateInputSchema)(input);
      })
    );

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
    this.appendEvent(entryId, "list.state", origin, { ...changes });

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
        payload: {
          entryId,
          anilistId,
          ...(mediaListEntryId !== undefined ? { mediaListEntryId } : {}),
          ...(nextStatus !== undefined ? { status: nextStatus } : {}),
          ...(nextScore !== undefined ? { score: nextScore } : {}),
          ...(nextNotes !== undefined ? { notes: nextNotes } : {}),
          ...(nextStarted !== undefined ? { startedAt: nextStarted } : {}),
          ...(nextCompleted !== undefined ? { completedAt: nextCompleted } : {}),
          ...(nextVolumes !== undefined ? { volumeProgress: nextVolumes } : {})
        }
      });
    }

    const stored = this.readListState(entryId);
    if (!stored) throw new Error(`List state missing after write: ${entryId}`);
    return stored;
  }

  async getListState(entryId: string): Promise<ListState | undefined> {
    return Effect.runSync(Effect.sync(() => this.readListState(entryId)));
  }

  // Removal is a full nuke: the AniList entry is deleted outright and the
  // registry row is tombstoned so history survives upstream.
  async nukeEntry(entryId: string, input: unknown): Promise<ListState | undefined> {
    const record = (input as { origin?: unknown } | null | undefined) ?? {};
    const origin: OpOrigin =
      record.origin === "device" || record.origin === "cli" || record.origin === "migration"
        ? record.origin
        : "admin";
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
          ...(current?.mediaListEntryId !== undefined
            ? { mediaListEntryId: current.mediaListEntryId }
            : {})
        }
      });
    }

    const timestamp = now();
    this.ctx.storage.sql.exec(
      "UPDATE canonical_entries SET tombstoned_at = ?, updated_at = ? WHERE id = ?",
      timestamp,
      timestamp,
      entryId
    );
    this.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", entryId);
    this.appendEvent(entryId, "list.nuke", origin, { anilistId });
    console.log(`[ManifoldSync] registry nuked:${entryId}:${origin}`);
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
        ).map((row) => ({
          id: row.id,
          entryId: row.entry_id,
          kind: row.kind,
          origin: row.origin,
          ...(row.detail ? { detail: JSON.parse(row.detail) as Record<string, unknown> } : {}),
          createdAt: row.created_at
        }));
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

  async completeOps(input: unknown): Promise<{ updated: number }> {
    const body = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Schema.decodeUnknownEffect(CompleteOpsInputSchema)(input);
      })
    );
    let updated = 0;
    const timestamp = now();
    for (const result of body.results) {
      const row = this.ctx.storage.sql
        .exec<OpRow>("SELECT * FROM sync_ops WHERE op_id = ?", result.opId)
        .toArray()[0];
      if (!row || row.state !== "pending") continue;
      if (result.ok) {
        this.ctx.storage.sql.exec(
          `UPDATE sync_ops SET state = 'completed', attempts = ?, updated_at = ?
           WHERE id = ?`,
          row.attempts + 1,
          timestamp,
          row.id
        );
        if (result.mediaListEntryId !== undefined && row.target === "anilist") {
          const payload = JSON.parse(row.payload) as { entryId?: string };
          if (payload.entryId) {
            this.ctx.storage.sql.exec(
              "UPDATE list_state SET media_list_entry_id = ? WHERE entry_id = ?",
              result.mediaListEntryId,
              payload.entryId
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
    return row ? this.toOp(row) : undefined;
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
        return rows.map((row) => this.toOp(row));
      })
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
        console.log(
          `[ManifoldSync] MangaDex read synced:${group.entryId}:chapters=${group.chapters.length}`
        );
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
    if (pending.length === 0) return;

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
            console.log(`[ManifoldSync] MangaDex shelf mirrored:${row.entry_id}:${mdLink.external_id}:reading`);
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

  private failOps(rows: readonly { id: number; attempts: number }[], error: unknown): void {
    for (const row of rows) {
      const attempt = row.attempts + 1;
      const state: OpState = attempt >= SYNC_MAX_ATTEMPTS ? "blocked" : "pending";
      this.ctx.storage.sql.exec(
        `UPDATE sync_ops
         SET state = ?, attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
        state,
        attempt,
        errorMessage(error).slice(0, 500),
        now(),
        row.id
      );
      console.error(
        `[ManifoldSync] op failed:${row.id}:attempt=${attempt}:` +
          `${state}:${errorMessage(error)}`
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
    if (pending === 0 && shelfPending === 0) return;

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
    const encryptedAccessToken = await this.encryptToken(token.access_token);
    const encryptedRefreshToken = token.refresh_token
      ? await this.encryptToken(token.refresh_token)
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
      ...(expiresAt === null ? {} : { expiresAt }),
      updatedAt: timestamp
    };
  }

  private readAuthConnection(provider: AuthProvider): AuthConnection {
    const row = this.readAuthToken(provider);
    return {
      provider,
      connected: row !== undefined,
      ...(row?.expires_at === null || row?.expires_at === undefined
        ? {}
        : { expiresAt: row.expires_at }),
      ...(row ? { updatedAt: row.updated_at } : {})
    };
  }

  private readAuthToken(provider: AuthProvider): OAuthTokenRow | undefined {
    return this.ctx.storage.sql
      .exec<OAuthTokenRow>("SELECT * FROM oauth_tokens WHERE provider = ?", provider)
      .toArray()[0];
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const encryptionSecret = await readSecret(
      this.env.OAUTH_TOKEN_ENCRYPTION_SECRET,
      "OAUTH_TOKEN_ENCRYPTION_SECRET"
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(encryptionSecret)
    );
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt"
    ]);
  }

  private async encryptToken(value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.encryptionKey(),
      new TextEncoder().encode(value)
    );
    const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.byteLength);
    return toBase64Url(combined);
  }

  private async decryptToken(value: string): Promise<string> {
    const combined = fromBase64Url(value);
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await this.encryptionKey(),
      encrypted
    );
    return new TextDecoder().decode(decrypted);
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
    if (!legacy) return;
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
    payload: Record<string, unknown>;
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
    ).map((row) => this.toOp(row));
    return rows;
  }

  private toOp(row: OpRow): SyncOp {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = { raw: row.payload };
    }
    return {
      id: row.id,
      opId: row.op_id,
      target: row.target,
      kind: row.kind,
      origin: row.origin,
      payload,
      state: row.state,
      attempts: row.attempts,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private readListState(entryId: string): ListState | undefined {
    const row = this.ctx.storage.sql
      .exec<ListStateRow>("SELECT * FROM list_state WHERE entry_id = ?", entryId)
      .toArray()[0];
    if (!row) return undefined;
    return {
      entryId: row.entry_id,
      ...(row.status === null ? {} : { status: row.status as ListState["status"] }),
      ...(row.score === null ? {} : { score: row.score }),
      ...(row.notes === null ? {} : { notes: row.notes }),
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.volume_progress === null ? {} : { volumeProgress: row.volume_progress }),
      ...(row.media_list_entry_id === null ? {} : { mediaListEntryId: row.media_list_entry_id }),
      updatedAt: row.updated_at
    };
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
    detail?: Record<string, unknown>
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

  private readEntry(entryId: string, required = true): CanonicalEntry | undefined {
    const row = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM canonical_entries WHERE id = ?", entryId)
      .toArray()[0];
    if (!row) {
      if (required) throw new Error(`Canonical entry not found: ${entryId}`);
      return undefined;
    }

    const providers = this.ctx.storage.sql
      .exec<ProviderRow>(
        "SELECT provider, external_id, title, updated_at FROM provider_links WHERE entry_id = ? ORDER BY provider",
        entryId
      )
      .toArray()
      .map((provider) => ({
        provider: provider.provider,
        externalId: provider.external_id,
        ...(provider.title === null ? {} : { title: provider.title }),
        updatedAt: provider.updated_at
      }));

    return {
      id: row.id,
      provider: row.provider,
      providerId: row.provider_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      providers
    };
  }

  private getProgressSync(entryId: string): ReadingProgress | undefined {
    const row = this.ctx.storage.sql
      .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", entryId)
      .toArray()[0];
    return row ? this.toProgress(row) : undefined;
  }

  private toProgress(row: ProgressRow): ReadingProgress {
    return {
      entryId: row.entry_id,
      chapterKey: row.chapter_key,
      ...(row.chapter_number === null ? {} : { chapterNumber: row.chapter_number }),
      ...(row.volume_number === null ? {} : { volumeNumber: row.volume_number }),
      ...(row.provider === null ? {} : { provider: row.provider }),
      ...(row.source_chapter_id === null ? {} : { sourceChapterId: row.source_chapter_id }),
      readAt: row.read_at,
      version: row.version
    };
  }
}
