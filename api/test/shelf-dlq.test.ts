/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics globalDate:off */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toJsonText } from "@manifold/json/text";
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
  async ageShelf(entryId, ms) {
    this.ctx.storage.sql.exec("UPDATE md_status_queue SET updated_at = updated_at - ? WHERE entry_id = ?", ms, entryId);
  }
  async retryAll() {
    return this.retryFailedSync();
  }
  async seedOp(opId, state) {
    this.ctx.storage.sql.exec(
      "INSERT INTO sync_ops (op_id, target, kind, origin, payload, state, attempts, created_at, updated_at) VALUES (?, 'mangadex', 'mangadex.read', 'device', '{}', ?, 0, 1, 1)",
      opId, state,
    );
  }
  async seedTracked(entryId) {
    this.ctx.storage.sql.exec(
      "INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at) VALUES (?, 'local', ?, 'Shelf DLQ', 1, 1) ON CONFLICT(id) DO NOTHING",
      entryId, entryId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO provider_links (entry_id, provider, external_id, title, source_name, updated_at) VALUES (?, 'mangadex', ?, 'Shelf DLQ', NULL, 1)",
      entryId, 'md-' + entryId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO progress_state (entry_id, chapter_key, chapter_number, volume_number, provider, source_chapter_id, read_at, version) VALUES (?, 'c1', 1, NULL, 'mangadex', 'ch', 1, 1)",
      entryId,
    );
  }
  async backfill() {
    return this.backfillMangaDexShelf();
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
  if (input.op === 'age') { await sync.ageShelf(input.entryId, input.ms); return Response.json({ ok: true }); }
  if (input.op === 'retry') { return Response.json(await sync.retryAll()); }
  if (input.op === 'seed-op') { await sync.seedOp(input.opId, input.state); return Response.json({ ok: true }); }
  if (input.op === 'seed-tracked') { await sync.seedTracked(input.entryId); return Response.json({ ok: true }); }
  if (input.op === 'backfill') { return Response.json(await sync.backfill()); }
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
const BackfillResponse = Schema.Struct({ enqueued: Schema.Finite });
const ScheduleResponse = Schema.Struct({ alarm: Schema.NullOr(Schema.Finite) });

type ShelfRowValue = Schema.Schema.Type<typeof ShelfRow>;

interface FixtureBody {
  readonly op: string;
  readonly nonce: string;
  readonly entryId?: string;
  readonly attempts?: number;
  readonly ms?: number;
  readonly lastError?: string | null;
  readonly message?: string;
  readonly opId?: string;
  readonly state?: string;
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

    const [output] = built.outputFiles;

    if (!output) {
      throw new Error("esbuild produced no output");
    }

    worker = new Miniflare(
      convertV4MiniflareOptions({
        name: "shelf-dlq-test",
        modules: true,
        script: output.text,
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
      body: toJsonText(body),
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
    const failedAt = Date.now();
    await failShelf(nonce, "entry-retry", 2, "timeout");
    const rows = await readRows(nonce);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: "entry-retry", attempts: 2 });
    expect(rows[0]?.last_error).toContain("timeout");
    // The second failure waits 20 s before the next try.
    expect(await scheduledAlarm(nonce)).toBeGreaterThanOrEqual(failedAt + 20_000);
  });

  it("re-arms blocked rows through retryFailedSync", async () => {
    const nonce = "shelf-rearm";
    await seedShelf(nonce, "entry-rearm", 5, "boom");
    expect(await retryAll(nonce)).toBe(1);
    expect(await readRows(nonce)).toEqual([
      { entry_id: "entry-rearm", attempts: 0, last_error: null },
    ]);
  });

  it("counts only the rows a retry re-armed", async () => {
    const nonce = "shelf-retry-count";
    await seedShelf(nonce, "entry-blocked", 5, "boom");
    await seedShelf(nonce, "entry-pending", 1, null);
    expect(
      (await dispatch({ op: "seed-op", nonce, opId: "op-blocked", state: "blocked" })).status,
    ).toBe(200);

    for (const opId of ["op-a", "op-b", "op-c"]) {
      expect((await dispatch({ op: "seed-op", nonce, opId, state: "pending" })).status).toBe(200);
    }

    expect(await retryAll(nonce)).toBe(2);
    expect(await retryAll(nonce)).toBe(0);
  });

  it("reports how many entries a shelf backfill enqueued", async () => {
    const nonce = "shelf-backfill";

    for (const entryId of ["entry-a", "entry-b", "entry-c"]) {
      expect((await dispatch({ op: "seed-tracked", nonce, entryId })).status).toBe(200);
    }

    await seedShelf(nonce, "entry-a", 0, null);

    const backfill = async (): Promise<number> => {
      const response = await dispatch({ op: "backfill", nonce });
      expect(response.status).toBe(200);

      return Schema.decodeUnknownSync(BackfillResponse)(await response.json()).enqueued;
    };

    expect(await backfill()).toBe(2);
    expect(await readRows(nonce)).toHaveLength(3);
    expect(await backfill()).toBe(0);
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

  it("backs off a failing drain batch with its cause and never blocks the rows", async () => {
    const nonce = "shelf-batch-fail";
    const entryId = "entry-batch";
    await seedShelf(nonce, entryId, 0, null);

    const attemptsAfterDrain = async (): Promise<number | undefined> => {
      await drainShelf(nonce);

      return (await readRows(nonce))[0]?.attempts;
    };

    const age = async (ms: number): Promise<void> => {
      expect((await dispatch({ op: "age", nonce, entryId, ms })).status).toBe(200);
    };

    // No MangaDex credentials in the fixture, so the batch fails before any
    // per-row work. The row keeps its place and records why.
    const before = Date.now();
    expect(await attemptsAfterDrain()).toBe(1);
    expect((await readRows(nonce))[0]?.last_error).toContain("mangadex");
    expect(await scheduledAlarm(nonce)).toBeGreaterThanOrEqual(before + 5_000);

    // Not due yet: a drain right away does not try it again.
    expect(await attemptsAfterDrain()).toBe(1);

    // 5 s after the first failure it is due; the second failure waits 20 s.
    await age(5_000);
    expect(await attemptsAfterDrain()).toBe(2);
    await age(15_000);
    expect(await attemptsAfterDrain()).toBe(2);

    // However long the outage, the row stays one attempt short of blocked.
    for (const expected of [3, 4, 4, 4]) {
      await age(3_600_000);
      expect(await attemptsAfterDrain()).toBe(expected);
    }
  });
});
