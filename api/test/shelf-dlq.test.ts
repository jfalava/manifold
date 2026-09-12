/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Schema } from "effect";

// Shelf-mirror DLQ: the fifth failure parks the row as blocked with last_error
// instead of deleting it; retryFailedSync re-arms it. Exercises real SQLite
// through the DO without touching upstream MangaDex.
const fixture = `
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async alarm() {}
  async seedShelf(entryId, attempts, lastError) {
    this.ctx.storage.sql.exec(
      "INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at) VALUES (?, 'local', ?, 'Shelf DLQ', 1, 1) ON CONFLICT(id) DO NOTHING",
      entryId, entryId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO md_status_queue (entry_id, created_at, attempts, last_error) VALUES (?, 1, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET attempts = excluded.attempts, last_error = excluded.last_error",
      entryId, attempts, lastError,
    );
  }
  async failShelf(entryId, attempts, message) {
    this.failShelfEntry(entryId, attempts, new Error(message));
  }
  async readShelf() {
    return this.ctx.storage.sql.exec("SELECT entry_id, attempts, last_error FROM md_status_queue ORDER BY entry_id").toArray();
  }
  async drainShelf() {
    await this.drainMangaDexStatusQueue();
  }
  async retryAll() {
    return this.retryFailedSync();
  }
  async scheduleState() {
    await this.scheduleSync();
    return this.ctx.storage.getAlarm();
  }
}
export default { async fetch(request, env) {
  const input = await request.json();
  const sync = env.MANIFOLD_SYNC.getByName(input.nonce);
  if (input.op === 'seed') { await sync.seedShelf(input.entryId, input.attempts, input.lastError); return Response.json({ ok: true }); }
  if (input.op === 'fail') { await sync.failShelf(input.entryId, input.attempts, input.message); return Response.json({ ok: true }); }
  if (input.op === 'read') { return Response.json({ rows: await sync.readShelf() }); }
  if (input.op === 'drain') { await sync.drainShelf(); return Response.json({ ok: true }); }
  if (input.op === 'retry') { return Response.json(await sync.retryAll()); }
  if (input.op === 'schedule') { return Response.json({ alarm: await sync.scheduleState() }); }
  return Response.json({ ok: false }, { status: 400 });
} };`;

const ShelfRow = Schema.Struct({
  entry_id: Schema.String,
  attempts: Schema.Finite,
  last_error: Schema.NullOr(Schema.String),
});
const ReadResponse = Schema.Struct({ rows: Schema.Array(ShelfRow) });
const RetryResponse = Schema.Struct({ retried: Schema.Finite });
const ScheduleResponse = Schema.Struct({ alarm: Schema.NullOr(Schema.Finite) });

type ShelfRowValue = Schema.Schema.Type<typeof ShelfRow>;

interface FixtureBody {
  readonly op: string;
  readonly nonce: string;
  readonly entryId?: string;
  readonly attempts?: number;
  readonly lastError?: string | null;
  readonly message?: string;
}

describe("MangaDex shelf DLQ", () => {
  let worker: Miniflare;

  beforeAll(async () => {
    const built = await build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
    });
    worker = new Miniflare(
      convertV4MiniflareOptions({
        name: "shelf-dlq-test",
        modules: true,
        script: built.outputFiles[0].text,
        compatibilityDate: "2026-08-28",
        durableObjects: { MANIFOLD_SYNC: { className: "TestSync", useSQLite: true } },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  const dispatch = (body: FixtureBody) =>
    worker.dispatchFetch("https://fixture.test", {
      method: "POST",
      body: JSON.stringify(body),
    });

  const seedShelf = async (
    nonce: string,
    entryId: string,
    attempts: number,
    lastError: string | null,
  ): Promise<void> => {
    const response = await dispatch({ op: "seed", nonce, entryId, attempts, lastError });
    expect(response.status).toBe(200);
  };

  const failShelf = async (
    nonce: string,
    entryId: string,
    attempts: number,
    message: string,
  ): Promise<void> => {
    const response = await dispatch({ op: "fail", nonce, entryId, attempts, message });
    expect(response.status).toBe(200);
  };

  const drainShelf = async (nonce: string): Promise<void> => {
    const response = await dispatch({ op: "drain", nonce });
    expect(response.status).toBe(200);
  };

  const readRows = async (nonce: string): Promise<readonly ShelfRowValue[]> => {
    const response = await dispatch({ op: "read", nonce });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(ReadResponse)(await response.json()).rows;
  };

  const retryAll = async (nonce: string): Promise<number> => {
    const response = await dispatch({ op: "retry", nonce });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(RetryResponse)(await response.json()).retried;
  };

  const scheduledAlarm = async (nonce: string): Promise<number | null> => {
    const response = await dispatch({ op: "schedule", nonce });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(ScheduleResponse)(await response.json()).alarm;
  };

  it("parks the fifth failure as blocked with last_error instead of deleting", async () => {
    const nonce = "shelf-park";
    await seedShelf(nonce, "entry-park", 4, null);
    await failShelf(nonce, "entry-park", 5, "upstream 500");
    const rows = await readRows(nonce);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: "entry-park", attempts: 5 });
    expect(rows[0]?.last_error).toContain("upstream 500");
  });

  it("keeps sub-max failures pending with last_error", async () => {
    const nonce = "shelf-retryable";
    await seedShelf(nonce, "entry-retry", 1, null);
    await failShelf(nonce, "entry-retry", 2, "timeout");
    const rows = await readRows(nonce);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: "entry-retry", attempts: 2 });
    expect(rows[0]?.last_error).toContain("timeout");
    expect(await scheduledAlarm(nonce)).toEqual(expect.any(Number));
  });

  it("re-arms blocked rows through retryFailedSync", async () => {
    const nonce = "shelf-rearm";
    await seedShelf(nonce, "entry-rearm", 5, "boom");
    expect(await retryAll(nonce)).toBe(1);
    expect(await readRows(nonce)).toEqual([
      { entry_id: "entry-rearm", attempts: 0, last_error: null },
    ]);
  });

  it("leaves blocked rows alone on drain and does not schedule for them", async () => {
    const nonce = "shelf-blocked-idle";
    await seedShelf(nonce, "entry-idle", 5, "auth");
    await drainShelf(nonce);
    expect(await readRows(nonce)).toEqual([
      { entry_id: "entry-idle", attempts: 5, last_error: "auth" },
    ]);
    expect(await scheduledAlarm(nonce)).toBeNull();
  });

  it("leaves pending rows intact when the drain batch fails", async () => {
    const nonce = "shelf-batch-fail";
    await seedShelf(nonce, "entry-batch", 0, null);
    // No MangaDex credentials in the fixture, so the batch fails before any
    // per-row write: the queue must stay intact for the next alarm.
    await drainShelf(nonce);
    expect(await readRows(nonce)).toEqual([
      { entry_id: "entry-batch", attempts: 0, last_error: null },
    ]);
  });
});
