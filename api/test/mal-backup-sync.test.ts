/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from "miniflare";
import { Schema } from "effect";
import { RegistryEntry, SyncOp, ListState } from "@manifold/contract";
import { isJsonValue, type JsonObject, type JsonValue } from "@manifold/json";

// The production DO and its actual SQLite schema run in workerd. Only alarm
// timing and external HTTP are controlled; no production modules are mocked.
const fixture = `
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async pause() { this.ctx.storage.kv.put('registry_sync_paused', true); }
  async drain() {
    this.ctx.storage.kv.delete('registry_sync_paused');
    try { await this.alarm(); }
    finally { await this.pause(); await this.ctx.storage.deleteAlarm(); }
  }
}
export default { async fetch(request, env) {
  const sync = env.MANIFOLD_SYNC.getByName('default');
  const input = await request.json();
  let result;
  switch (input.action) {
    case 'init': await sync.pause(); result = await sync.importAuthToken('mal', 'fixture-token'); break;
    case 'entry': result = await sync.resolveEntry({provider:'anilist', providerId:input.id, title:input.title ?? 'Title'}); break;
    case 'set': result = await sync.setListState(input.id, input.change); break;
    case 'link': result = await sync.linkProvider(input.id, {provider:'mal', externalId:input.malId}); break;
    case 'nuke': result = await sync.nukeEntry(input.id, {origin:'device'}); break;
    case 'drain': await sync.drain(); result = {}; break;
    case 'retry': result = await sync.retryOp(input.opId); await sync.pause(); break;
    case 'get': result = await sync.getEntry(input.id); break;
    case 'ops': result = await sync.listOps(undefined, 'mal'); break;
    default: throw new Error('Unknown fixture action');
  }
  return Response.json(result);
} };`;

describe("Worker-side MAL backup outbox", () => {
  let worker: Miniflare;
  const writes: { path: string; body: string }[] = [];
  let upstreamStatus = 200;

  const request = async (input: JsonObject): Promise<JsonValue> => {
    const response = await worker.dispatchFetch("https://fixture.test", {
      method: "POST",
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    if (!isJsonValue(body)) {
      throw new Error("Invalid fixture response");
    }
    return body;
  };
  const createEntry = async (id: string): Promise<RegistryEntry> =>
    Schema.decodeUnknownSync(RegistryEntry)(await request({ action: "entry", id }));
  const readOps = async () =>
    Schema.decodeUnknownSync(Schema.Array(SyncOp))(await request({ action: "ops" }));

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
        name: "mal-test",
        modules: true,
        script: built.outputFiles[0].text,
        compatibilityDate: "2026-08-28",
        durableObjects: { MANIFOLD_SYNC: { className: "TestSync", useSQLite: true } },
        bindings: {
          MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: "test-encryption-key",
          MANIFOLD_MAL_CLIENT_ID: "test-client",
        },
        outboundService: async (outbound) => {
          const url = new URL(outbound.url);
          if (url.hostname !== "api.myanimelist.net") {
            throw new Error(`Unexpected upstream: ${url.hostname}`);
          }
          if (outbound.method === "PATCH") {
            writes.push({ path: url.pathname, body: await outbound.text() });
            return new WorkerResponse("{}", { status: upstreamStatus });
          }
          return WorkerResponse.json({
            data: [
              { node: { id: 900, title: "Title", alternative_titles: { synonyms: ["Alias"] } } },
            ],
          });
        },
      }),
    );
    await request({ action: "init" });
  }, 30_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  it("backs up the latest tracker state, persists an ID binding, and retains canonical identity", async () => {
    const entry = await createEntry("42");
    await request({
      action: "set",
      id: entry.id,
      change: {
        origin: "device",
        appliedRemotely: true,
        status: "reading",
        backupIdentity: { anilistId: "42", malId: "7", titles: ["Title", "Alias"] },
      },
    });
    await request({
      action: "set",
      id: entry.id,
      change: { origin: "device", appliedRemotely: true, status: "completed" },
    });
    expect(writes).toHaveLength(0);
    expect((await readOps()).filter((op) => op.state === "pending")).toHaveLength(1);
    await request({ action: "drain" });
    expect(writes).toEqual([
      { path: "/v2/manga/7/my_list_status", body: "status=completed&is_rereading=false" },
    ]);
    // Retention: successful drains delete op rows instead of logging them.
    expect(await readOps()).toHaveLength(0);
    const stored = Schema.decodeUnknownSync(RegistryEntry)(
      await request({ action: "get", id: entry.id }),
    );
    expect(stored).toMatchObject({
      id: entry.id,
      provider: "anilist",
      providerId: "42",
      title: "Title",
    });
    expect(stored.providers).toContainEqual(
      expect.objectContaining({ provider: "mal", externalId: "7" }),
    );
  });

  it("finds an unbound entry by title and updates it in the same drain", async () => {
    const entry = await createEntry("43");
    await request({
      action: "set",
      id: entry.id,
      change: { origin: "device", status: "on_hold", appliedRemotely: true },
    });
    await request({ action: "drain" });
    expect(writes.at(-1)).toEqual({
      path: "/v2/manga/900/my_list_status",
      body: "status=on_hold&is_rereading=false",
    });
  });

  it("does not steal a MAL binding already owned by another entry", async () => {
    const entry = await createEntry("44");
    const before = writes.length;
    await request({
      action: "set",
      id: entry.id,
      change: {
        origin: "device",
        status: "reading",
        appliedRemotely: true,
        backupIdentity: { anilistId: "44", malId: "7", titles: [] },
      },
    });
    await request({ action: "drain" });
    expect(writes).toHaveLength(before);
    const conflict = (await readOps()).find((op) => op.payload.entryId === entry.id);
    expect(conflict?.state).toBe("pending");
    expect(conflict?.attempts).toBe(1);
    expect(conflict?.lastError).toContain("another registry entry");
    await request({ action: "nuke", id: entry.id });
  });

  it("keeps upstream failures out of the tracker response and retries current state", async () => {
    const entry = await createEntry("45");
    await request({ action: "link", id: entry.id, malId: "8" });
    upstreamStatus = 503;
    const state = Schema.decodeUnknownSync(ListState)(
      await request({
        action: "set",
        id: entry.id,
        change: {
          origin: "device",
          status: "reading",
          appliedRemotely: true,
        },
      }),
    );
    expect(state.status).toBe("reading");
    await request({ action: "drain" });
    const failed = (await readOps()).find((op) => op.payload.entryId === entry.id);
    expect(failed?.state).toBe("pending");
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toContain("503");
    upstreamStatus = 200;
    await request({
      action: "set",
      id: entry.id,
      change: { origin: "device", status: "dropped", appliedRemotely: true },
    });
    await request({ action: "drain" });
    expect(writes.at(-1)?.body).toBe("status=dropped&is_rereading=false");
  });

  it("skips deleted entries and explicit status clears; admin updates do not originate backups", async () => {
    const deleted = await createEntry("46");
    const cleared = await createEntry("47");
    const admin = await createEntry("48");
    for (const entry of [deleted, cleared]) {
      await request({
        action: "set",
        id: entry.id,
        change: { origin: "device", status: "reading", appliedRemotely: true },
      });
    }
    await request({ action: "nuke", id: deleted.id });
    await request({
      action: "set",
      id: cleared.id,
      change: { origin: "device", status: null, appliedRemotely: true },
    });
    await request({ action: "set", id: admin.id, change: { origin: "admin", status: "reading" } });
    const before = writes.length;
    await request({ action: "drain" });
    expect(writes).toHaveLength(before);
    expect((await readOps()).filter((op) => op.state === "pending")).toHaveLength(0);
  });

  it("blocks repeated failures and supports explicit retry without replaying old state", async () => {
    const entry = await createEntry("49");
    await request({ action: "link", id: entry.id, malId: "9" });
    await request({
      action: "set",
      id: entry.id,
      change: { origin: "device", status: "reading", appliedRemotely: true },
    });
    upstreamStatus = 401;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request({ action: "drain" });
    }
    const blocked = (await readOps()).find((op) => op.payload.entryId === entry.id);
    expect(blocked).toMatchObject({ state: "blocked", attempts: 5 });
    if (!blocked) {
      throw new Error("Missing backup op");
    }
    // Admin does not originate another backup, but a retry must still read
    // the latest canonical state rather than replaying the original status.
    await request({
      action: "set",
      id: entry.id,
      change: { origin: "admin", status: "completed", appliedRemotely: true },
    });
    upstreamStatus = 200;
    await request({ action: "retry", opId: blocked.opId });
    await request({ action: "drain" });
    expect(writes.at(-1)?.body).toBe("status=completed&is_rereading=false");
    // Successes are not logged: the op row is deleted instead of marked completed.
    const completed = (await readOps()).find((op) => op.opId === blocked.opId);
    expect(completed).toBeUndefined();
  });
});
