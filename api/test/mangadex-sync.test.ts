/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from "miniflare";
import { Effect, Schema } from "effect";
import { MangaDexEntryStat, MangaDexLibraryItem, SyncOp } from "@manifold/contract";
import { isJsonValue, type JsonObject, type JsonValue } from "@manifold/json";
import { toJsonText } from "@manifold/json/text";

// The production DO and its SQLite schema run in workerd, one object per
// nonce. Only upstream MangaDex HTTP and the moment the alarm runs are
// controlled; no production module is mocked.
const fixture = `
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async seedRead(opId, entryId, mangaDexId) {
    this.ctx.storage.sql.exec(
      "INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at) VALUES (?, 'local', ?, 'Drain title', 1, 1) ON CONFLICT(id) DO NOTHING",
      entryId, entryId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO provider_links (entry_id, provider, external_id, title, source_name, updated_at) VALUES (?, 'mangadex', ?, 'Drain title', NULL, 1) ON CONFLICT DO NOTHING",
      entryId, mangaDexId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO sync_ops (op_id, target, kind, origin, payload, state, attempts, created_at, updated_at) VALUES (?, 'mangadex', 'mangadex.read', 'device', ?, 'pending', 0, 1, 1)",
      opId,
      JSON.stringify({ entryId, eventId: opId, chapterKey: 'c1', provider: 'mangadex', sourceChapterId: 'chapter-' + opId, readAt: 1 }),
    );
  }
  async clearAlarm() { await this.ctx.storage.deleteAlarm(); }
  async expireToken() {
    this.ctx.storage.sql.exec("UPDATE oauth_tokens SET expires_at = 1 WHERE provider = 'mangadex'");
  }
  async elapse(ms) {
    this.ctx.storage.sql.exec("UPDATE sync_ops SET updated_at = updated_at - ?", ms);
  }
  async drain() {
    let rejected = null;
    try { await this.alarm(); } catch (error) { rejected = String(error && error.message); }
    const alarm = await this.ctx.storage.getAlarm();
    await this.ctx.storage.deleteAlarm();
    return { rejected, alarmInMs: alarm === null ? null : alarm - Date.now(), ops: await this.listOps(undefined, 'mangadex') };
  }
  async scheduled() {
    // The gate keeps an alarm set for now from running before it is read.
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.scheduleSync();
      const alarm = await this.ctx.storage.getAlarm();
      await this.ctx.storage.deleteAlarm();
      return { alarmInMs: alarm === null ? null : alarm - Date.now() };
    });
  }
}
export default { async fetch(request, env) {
  const input = await request.json();
  const sync = env.MANIFOLD_SYNC.getByName(input.nonce);
  let result;
  switch (input.action) {
    case 'login': result = await sync.loginMangaDex(); await sync.clearAlarm(); break;
    case 'expire': await sync.expireToken(); result = {}; break;
    case 'seed-read': await sync.seedRead(input.opId, input.entryId, input.mangaDexId); result = {}; break;
    case 'elapse': await sync.elapse(input.ms); result = {}; break;
    case 'drain': result = await sync.drain(); break;
    case 'scheduled': result = await sync.scheduled(); break;
    case 'tokens': {
      const settled = await Promise.allSettled([
        sync.getAuthAccessToken('mangadex'),
        sync.getAuthAccessToken('mangadex'),
      ]);
      result = settled.map((outcome) => outcome.status === 'fulfilled' ? outcome.value : 'rejected: ' + outcome.reason.message);
      break;
    }
    case 'library': result = await sync.mangaDexLibrary(input.status); break;
    case 'stats': result = await sync.mangaDexStats(input.ids); break;
    default: throw new Error('Unknown fixture action');
  }
  return Response.json(result);
} };`;

const DrainResult = Schema.Struct({
  rejected: Schema.NullOr(Schema.String),
  alarmInMs: Schema.NullOr(Schema.Finite),
  ops: Schema.Array(SyncOp),
});

const ScheduledResult = Schema.Struct({ alarmInMs: Schema.NullOr(Schema.Finite) });

describe("MangaDex sync against a mocked upstream", () => {
  let worker: Miniflare;
  let shelf = new Map<string, string>();
  let markStatus = 200;
  let feedLength = 0;
  let feedFailsFromOffset = Number.POSITIVE_INFINITY;
  let refreshes: ((response: WorkerResponse) => void)[] = [];
  let racedRefresh = false;
  const marked: string[] = [];

  const feedIds = (mangaId: string): string[] =>
    Array.from({ length: feedLength }, (_, index) => `${mangaId}-chapter-${index}`);

  const tokenResponse = (accessToken: string): WorkerResponse =>
    WorkerResponse.json({
      access_token: accessToken,
      refresh_token: `${accessToken}-refresh`,
      token_type: "Bearer",
      expires_in: 900,
    });

  // Two refresh grants carrying the same refresh token: the first to arrive
  // wins and stores a new token before the loser is told its token is spent.
  const settleRefreshRace = async (): Promise<void> => {
    const [winner, loser] = refreshes;
    refreshes = [];
    winner?.(tokenResponse("access-refreshed"));
    await Effect.runPromise(Effect.sleep("300 millis"));
    loser?.(new WorkerResponse('{"error":"invalid_grant"}', { status: 400 }));
  };

  const request = async (input: JsonObject): Promise<JsonValue> => {
    const response = await worker.dispatchFetch("https://fixture.test", {
      method: "POST",
      body: toJsonText(input),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    if (!isJsonValue(body)) {
      throw new Error("Invalid fixture response");
    }

    return body;
  };

  const drain = async (nonce: string) =>
    Schema.decodeUnknownSync(DrainResult)(await request({ action: "drain", nonce }));

  const scheduled = async (nonce: string) =>
    Schema.decodeUnknownSync(ScheduledResult)(await request({ action: "scheduled", nonce }));

  const library = async (nonce: string, status?: string): Promise<readonly string[]> =>
    Schema.decodeUnknownSync(Schema.Array(MangaDexLibraryItem))(
      await request({ action: "library", nonce, ...(status !== undefined && { status }) }),
    ).map((row) => row.mangaDexId);

  beforeAll(async () => {
    const built = await build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
    });

    const [output] = built.outputFiles;

    if (!output) {
      throw new Error("esbuild produced no output");
    }

    worker = new Miniflare(
      convertV4MiniflareOptions({
        name: "mangadex-sync-test",
        modules: true,
        script: output.text,
        compatibilityDate: "2026-08-28",
        durableObjects: { MANIFOLD_SYNC: { className: "TestSync", useSQLite: true } },
        bindings: {
          MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: "test-encryption-key",
          MANIFOLD_MANGADEX_CLIENT_ID: "client",
          MANIFOLD_MANGADEX_CLIENT_SECRET: "secret",
          MANIFOLD_MANGADEX_USERNAME: "user",
          MANIFOLD_MANGADEX_PASSWORD: "password",
        },
        outboundService: async (outbound) => {
          const url = new URL(outbound.url);

          if (url.hostname === "auth.mangadex.org") {
            const form = new URLSearchParams(await outbound.text());

            if (form.get("grant_type") === "password") {
              return tokenResponse("access-login");
            }

            if (!racedRefresh) {
              return new WorkerResponse('{"error":"invalid_grant"}', { status: 400 });
            }

            const held = Promise.withResolvers<WorkerResponse>();
            refreshes.push(held.resolve);

            if (refreshes.length === 2) {
              void settleRefreshRace();
            }

            return held.promise;
          }

          if (url.hostname !== "api.mangadex.org") {
            throw new Error(`Unexpected upstream: ${url.hostname}`);
          }

          if (url.pathname === "/manga/status") {
            const wanted = url.searchParams.get("status");

            return WorkerResponse.json({
              result: "ok",
              statuses: Object.fromEntries(
                [...shelf].filter(([, status]) => wanted === null || status === wanted),
              ),
            });
          }

          if (url.pathname === "/manga/read") {
            return WorkerResponse.json({
              result: "ok",
              data: Object.fromEntries(
                url.searchParams
                  .getAll("ids[]")
                  .map((id) => [id, feedIds(id).slice(0, feedLength)]),
              ),
            });
          }

          if (url.pathname.endsWith("/feed")) {
            const mangaId = url.pathname.split("/")[2] ?? "";
            const offset = Number(url.searchParams.get("offset"));
            const limit = Number(url.searchParams.get("limit"));

            if (offset >= feedFailsFromOffset) {
              // 4xx: the MangaDex client retries 429 and 5xx with a delay.
              return new WorkerResponse('{"result":"error"}', { status: 400 });
            }

            return WorkerResponse.json({
              result: "ok",
              total: feedLength,
              data: feedIds(mangaId)
                .slice(offset, offset + limit)
                .map((id, index) => ({
                  id,
                  type: "chapter",
                  attributes: { chapter: String(feedLength - offset - index) },
                  relationships: [{ type: "manga", id: mangaId }],
                })),
            });
          }

          if (outbound.method === "POST" && url.pathname.endsWith("/read")) {
            if (markStatus === 200) {
              marked.push(url.pathname);
            }

            return new WorkerResponse('{"result":"ok"}', { status: markStatus });
          }

          // Titles, covers and ratings are cosmetic and best-effort.
          return WorkerResponse.json({ result: "ok", data: [], ratings: {}, total: 0 });
        },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  beforeEach(() => {
    shelf = new Map();
    markStatus = 200;
    feedLength = 0;
    feedFailsFromOffset = Number.POSITIVE_INFINITY;
    refreshes = [];
    racedRefresh = false;
    marked.length = 0;
  });

  it("records a token failure on the ops and still reschedules instead of rejecting the alarm", async () => {
    const nonce = "token-failure";
    await request({
      action: "seed-read",
      nonce,
      opId: "read-1",
      entryId: "entry-1",
      mangaDexId: "md-1",
    });

    // Never connected: the token lookup itself fails.
    const result = await drain(nonce);

    expect(result.rejected).toBeNull();
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]).toMatchObject({ opId: "read-1", state: "pending", attempts: 1 });
    expect(result.ops[0]?.lastError).toContain("Auth provider is not connected: mangadex");
    expect(result.alarmInMs).not.toBeNull();
  });

  it("never blocks an op over a sign-in outage, however long, and sends it once sign-in works", async () => {
    const nonce = "token-outage";
    await request({
      action: "seed-read",
      nonce,
      opId: "read-1",
      entryId: "entry-1",
      mangaDexId: "md-1",
    });

    let last = await drain(nonce);

    // Seven failed token lookups, two more than the attempt limit.
    for (let pass = 0; pass < 6; pass += 1) {
      await request({ action: "elapse", nonce, ms: 320_000 });
      last = await drain(nonce);
    }

    expect(last.ops[0]).toMatchObject({ opId: "read-1", state: "pending", attempts: 4 });
    expect(last.alarmInMs).toBeGreaterThan(300_000);

    await request({ action: "login", nonce });
    await request({ action: "elapse", nonce, ms: 320_000 });
    const recovered = await drain(nonce);

    expect(marked).toEqual(["/manga/md-1/read"]);
    expect(recovered.ops).toEqual([]);
  });

  it("gives the loser of a concurrent token refresh the token the winner stored", async () => {
    const nonce = "refresh-race";
    await request({ action: "login", nonce });
    await request({ action: "expire", nonce });
    racedRefresh = true;

    expect(await request({ action: "tokens", nonce })).toEqual([
      "access-refreshed",
      "access-refreshed",
    ]);
  });

  it("still fails a refresh that no concurrent caller repaired", async () => {
    const nonce = "refresh-rejected";
    await request({ action: "login", nonce });
    await request({ action: "expire", nonce });

    const tokens = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      await request({ action: "tokens", nonce }),
    );

    expect(tokens).toHaveLength(2);

    for (const token of tokens) {
      expect(token).toContain("Auth token refresh failed for mangadex (400)");
    }
  });

  it("adds titles first seen by a status-scoped refresh to the cached library", async () => {
    const nonce = "library-shelf";
    await request({ action: "login", nonce });
    shelf = new Map([["md-a", "reading"]]);
    expect(await library(nonce)).toEqual(["md-a"]);

    shelf = new Map([
      ["md-a", "reading"],
      ["md-b", "reading"],
    ]);
    expect(await library(nonce, "reading")).toEqual(["md-a", "md-b"]);
    // Served from the 24 hour cache: upstream is not asked for the shelves again.
    shelf = new Map();
    expect(await library(nonce)).toEqual(["md-a", "md-b"]);
  });

  it("waits longer after each failed attempt, keeps the attempt limit and does not hold back new ops", async () => {
    const nonce = "retry-backoff";
    await request({ action: "login", nonce });
    await request({
      action: "seed-read",
      nonce,
      opId: "slow",
      entryId: "entry-slow",
      mangaDexId: "md-slow",
    });
    // A refused write: 4xx is not retried inside the MangaDex client.
    markStatus = 400;

    const first = await drain(nonce);
    expect(first.ops[0]).toMatchObject({ opId: "slow", state: "pending", attempts: 1 });
    expect(first.alarmInMs).toBeGreaterThan(3_000);
    expect(first.alarmInMs).toBeLessThanOrEqual(5_000);

    // An alarm that fires before the delay has passed leaves the op alone.
    const early = await drain(nonce);
    expect(early.ops[0]).toMatchObject({ opId: "slow", state: "pending", attempts: 1 });

    const waits: (number | null)[] = [];

    for (const delay of [5_000, 20_000, 80_000]) {
      await request({ action: "elapse", nonce, ms: delay });
      waits.push((await drain(nonce)).alarmInMs);
    }

    expect(waits[0]).toBeGreaterThan(18_000);
    expect(waits[0]).toBeLessThanOrEqual(20_000);
    expect(waits[1]).toBeGreaterThan(78_000);
    expect(waits[1]).toBeLessThanOrEqual(80_000);
    expect(waits[2]).toBeGreaterThan(318_000);
    expect(waits[2]).toBeLessThanOrEqual(320_000);

    // A new op is due at once and is not queued behind the waiting one.
    await request({
      action: "seed-read",
      nonce,
      opId: "fresh",
      entryId: "entry-fresh",
      mangaDexId: "md-fresh",
    });
    expect((await scheduled(nonce)).alarmInMs).toBeLessThanOrEqual(0);
    markStatus = 200;
    const mixed = await drain(nonce);
    expect(marked).toEqual(["/manga/md-fresh/read"]);
    expect(mixed.ops.map((op) => [op.opId, op.attempts])).toEqual([["slow", 4]]);
    expect(mixed.alarmInMs).toBeGreaterThan(300_000);

    markStatus = 400;
    await request({ action: "elapse", nonce, ms: 320_000 });
    const last = await drain(nonce);
    expect(last.ops[0]).toMatchObject({ opId: "slow", state: "blocked", attempts: 5 });
    expect(last.alarmInMs).toBeNull();
  });

  it("counts read chapters over the whole feed of a series longer than one page", async () => {
    const nonce = "long-series";
    await request({ action: "login", nonce });
    feedLength = 1_200;

    const stats = Schema.decodeUnknownSync(Schema.Record(Schema.String, MangaDexEntryStat))(
      await request({ action: "stats", nonce, ids: ["md-long"] }),
    );

    expect(stats["md-long"]).toMatchObject({
      readChapters: 1_200,
      totalListed: 1_200,
      lastRead: 1_200,
      latestChapter: 1_200,
      percent: 100,
    });
  });

  it("answers with the pages it could read when a later feed page fails, and reads the feed again next time", async () => {
    const nonce = "feed-page-fails";
    await request({ action: "login", nonce });
    feedLength = 1_200;
    feedFailsFromOffset = 1_000;

    const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, MangaDexEntryStat));
    const partial = decode(await request({ action: "stats", nonce, ids: ["md-cut"] }));

    expect(partial["md-cut"]).toMatchObject({ readChapters: 1_000, totalListed: 1_200 });

    feedFailsFromOffset = Number.POSITIVE_INFINITY;
    const whole = decode(await request({ action: "stats", nonce, ids: ["md-cut"] }));

    expect(whole["md-cut"]).toMatchObject({ readChapters: 1_200, totalListed: 1_200 });
  });
});
