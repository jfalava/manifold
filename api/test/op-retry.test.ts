/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Schema } from "effect";
import { SyncOp } from "@manifold/contract";

// Exercise real SQLite and alarm storage, without executing upstream writes.
const fixture = `
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async alarm() {}
  async retryBlocked(target, paused) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.kv.put('registry_sync_paused', paused);
      this.ctx.storage.sql.exec(
        "INSERT INTO sync_ops (op_id, target, kind, payload, state, attempts, last_error, created_at, updated_at) VALUES ('blocked-op', ?, ?, '{}', 'blocked', 5, 'upstream failure', 1, 1)",
        target, target === 'mangadex' ? 'mangadex.read' : target + '.status',
      );
      const before = await this.ctx.storage.getAlarm();
      const op = await this.retryOp('blocked-op');
      const after = await this.ctx.storage.getAlarm();
      await this.ctx.storage.deleteAlarm();
      return { before, after, op };
    });
  }
}
export default { async fetch(request, env) {
  const { target, paused } = await request.json();
  const sync = env.MANIFOLD_SYNC.getByName(target + ':' + paused);
  return Response.json(await sync.retryBlocked(target, paused));
} };`;

const RetryResult = Schema.Struct({
  before: Schema.NullOr(Schema.Finite),
  after: Schema.NullOr(Schema.Finite),
  op: SyncOp,
});

describe("manual operation retry scheduling", () => {
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
        name: "op-retry-test",
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

  it.each([
    { target: "mangadex", paused: false, scheduled: true },
    { target: "mal", paused: false, scheduled: true },
    { target: "anilist", paused: false, scheduled: false },
    { target: "mangadex", paused: true, scheduled: false },
  ])(
    "retries $target with paused=$paused, scheduled=$scheduled",
    async ({ target, paused, scheduled }) => {
      const response = await worker.dispatchFetch("https://fixture.test", {
        method: "POST",
        body: JSON.stringify({ target, paused }),
      });
      expect(response.status).toBe(200);
      const result = Schema.decodeUnknownSync(RetryResult)(await response.json());
      expect(result.before).toBeNull();
      expect(result.after).toEqual(scheduled ? expect.any(Number) : null);
      expect(result.op).toMatchObject({
        opId: "blocked-op",
        target,
        state: "pending",
        attempts: 0,
      });
      expect(result.op.lastError).toBeUndefined();
    },
  );
});
