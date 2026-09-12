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
import { OpsSummary, SyncOp } from "@manifold/contract";

// Outbox retention: successes delete their sync_ops row instead of logging it,
// so the tables only hold actionable rows. OpsSummary additionally carries the
// shelf DLQ counts, which have no op rows of their own.
const fixture = `
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async alarm() {}
  async seedOp(opId, target, kind) {
    this.ctx.storage.sql.exec(
      "INSERT INTO sync_ops (op_id, target, kind, origin, payload, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'device', '{}', 'pending', 0, 1, 1)",
      opId, target, kind,
    );
  }
  async seedShelf(entryId, attempts, lastError) {
    this.ctx.storage.sql.exec(
      "INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at) VALUES (?, 'local', ?, 'Retention', 1, 1) ON CONFLICT(id) DO NOTHING",
      entryId, entryId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO md_status_queue (entry_id, created_at, attempts, last_error) VALUES (?, 1, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET attempts = excluded.attempts, last_error = excluded.last_error",
      entryId, attempts, lastError,
    );
  }
  async readAllOps() {
    return this.listOps();
  }
  async complete(results) {
    return this.completeOps({ results });
  }
  async summary() {
    return this.opsSummary();
  }
}
export default { async fetch(request, env) {
  const input = await request.json();
  const sync = env.MANIFOLD_SYNC.getByName(input.nonce);
  if (input.op === 'seed-op') { await sync.seedOp(input.opId, input.target, input.kind); return Response.json({ ok: true }); }
  if (input.op === 'seed-shelf') { await sync.seedShelf(input.entryId, input.attempts, input.lastError); return Response.json({ ok: true }); }
  if (input.op === 'read') { return Response.json({ ops: await sync.readAllOps() }); }
  if (input.op === 'complete') { return Response.json(await sync.complete(input.results)); }
  if (input.op === 'summary') { return Response.json(await sync.summary()); }
  return Response.json({ ok: false }, { status: 400 });
} };`;

const ReadResponse = Schema.Struct({ ops: Schema.Array(SyncOp) });
const CompleteResponse = Schema.Struct({ updated: Schema.Finite });

interface CompleteResult {
  readonly opId: string;
  readonly ok: boolean;
  readonly error?: string;
}

interface FixtureBody {
  readonly op: string;
  readonly nonce: string;
  readonly opId?: string;
  readonly target?: string;
  readonly kind?: string;
  readonly entryId?: string;
  readonly attempts?: number;
  readonly lastError?: string | null;
  readonly results?: readonly CompleteResult[];
}

describe("sync outbox retention and summary", () => {
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
        name: "ops-retention-test",
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

  const seedOp = async (nonce: string, opId: string, target: string, kind: string): Promise<void> => {
    const response = await dispatch({ op: "seed-op", nonce, opId, target, kind });
    expect(response.status).toBe(200);
  };

  const seedShelf = async (
    nonce: string,
    entryId: string,
    attempts: number,
    lastError: string | null,
  ): Promise<void> => {
    const response = await dispatch({ op: "seed-shelf", nonce, entryId, attempts, lastError });
    expect(response.status).toBe(200);
  };

  const readOps = async (nonce: string): Promise<readonly SyncOp[]> => {
    const response = await dispatch({ op: "read", nonce });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(ReadResponse)(await response.json()).ops;
  };

  const complete = async (nonce: string, results: readonly CompleteResult[]): Promise<number> => {
    const response = await dispatch({ op: "complete", nonce, results });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(CompleteResponse)(await response.json()).updated;
  };

  const summarize = async (nonce: string): Promise<OpsSummary> => {
    const response = await dispatch({ op: "summary", nonce });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(OpsSummary)(await response.json());
  };

  it("deletes device-acknowledged ops instead of marking them completed", async () => {
    const nonce = "retention-ack";
    await seedOp(nonce, "op-ack", "anilist", "anilist.fields");
    expect(await complete(nonce, [{ opId: "op-ack", ok: true }])).toBe(1);
    expect(await readOps(nonce)).toHaveLength(0);
  });

  it("retains device-reported failures with their error", async () => {
    const nonce = "retention-fail";
    await seedOp(nonce, "op-fail", "anilist", "anilist.fields");
    expect(await complete(nonce, [{ opId: "op-fail", ok: false, error: "device 500" }])).toBe(1);
    const ops = await readOps(nonce);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ opId: "op-fail", state: "pending", attempts: 1 });
    expect(ops[0]?.lastError).toContain("device 500");
  });

  it("reports shelf DLQ counts alongside op states", async () => {
    const nonce = "retention-summary";
    await seedOp(nonce, "op-sum", "mal", "mal.status");
    await seedShelf(nonce, "entry-pending", 1, null);
    await seedShelf(nonce, "entry-blocked", 5, "shelf-boom");
    const summary = await summarize(nonce);
    expect(summary.total).toBe(1);
    expect(summary.states).toEqual({ pending: 1 });
    expect(summary.oldestPendingAt).toBe(1);
    expect(summary.lastFailedError).toBeNull();
    expect(summary.shelfPending).toBe(1);
    expect(summary.shelfBlocked).toBe(1);
    expect(summary.shelfLastBlockedError).toBe("shelf-boom");
  });
});
