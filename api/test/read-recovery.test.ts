import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Schema } from "effect";
import { ReadingProgress, RegistryEntry, SyncOp } from "@manifold/contract";
import {
  arrayField,
  isFiniteNumber,
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";

const fixture = `
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async pause() { this.ctx.storage.kv.put('registry_sync_paused', true); }
  async snapshot() {
    return Object.fromEntries([
      'canonical_entries', 'provider_links', 'read_events', 'progress_state',
      'list_events', 'sync_ops', 'md_status_queue',
    ].map(table => [table, this.ctx.storage.sql.exec('SELECT * FROM ' + table).toArray()]));
  }
}
export default { async fetch(request, env) {
  const sync = env.MANIFOLD_SYNC.getByName('default');
  await sync.pause();
  const input = await request.json();
  try {
    let result;
    switch (input.action) {
      case 'entry': result = await sync.resolveEntry({provider:input.provider, providerId:input.id, title:'Title'}); break;
      case 'read': result = await sync.recordRead(input.id, input.read); break;
      case 'get': result = await sync.getEntry(input.id); break;
      case 'nuke': result = await sync.nukeEntry(input.id, {origin:'device'}); break;
      case 'ops': result = await sync.listOps(); break;
      case 'snapshot': result = await sync.snapshot(); break;
      default: throw new Error('Unknown fixture action');
    }
    return Response.json(result ?? null);
  } catch (error) { return Response.json({error:error.message}, {status:500}); }
} };`;

describe("queued reads with stale registry IDs", () => {
  let worker: Miniflare;
  const request = async (input: JsonObject, status = 200): Promise<JsonValue> => {
    const response = await worker.dispatchFetch("https://fixture.test", {
      method: "POST",
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(status);
    const body = await response.json();
    if (!isJsonValue(body)) {
      throw new Error("Invalid fixture response");
    }
    return body;
  };
  const entry = async (provider: string, id: string) =>
    Schema.decodeUnknownSync(RegistryEntry)(await request({ action: "entry", provider, id }));
  const read = (provider: string, sourceMangaId: string, eventId: string) => ({
    eventId,
    provider,
    sourceMangaId,
    sourceChapterId: "chapter-12",
    chapterKey: `${provider}:chapter-12`,
    chapterNumber: 12,
    readAt: 1_788_800_000_000,
  });

  const snapshotEntries = async (): Promise<readonly JsonObject[]> => {
    const snapshot = await request({ action: "snapshot" });
    if (!isJsonObject(snapshot)) {
      throw new Error("Invalid fixture snapshot");
    }
    const entries = arrayField(snapshot, "canonical_entries");
    if (entries === undefined) {
      throw new Error("Invalid fixture snapshot entries");
    }
    return entries.filter(isJsonObject);
  };
  const snapshotEntry = async (id: string): Promise<JsonObject> => {
    const row = (await snapshotEntries()).find((entry) => entry["id"] === id);
    if (row === undefined) {
      throw new Error(`Missing fixture entry ${id}`);
    }
    return row;
  };

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
        name: "read-recovery-test",
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

  it.each(["mangadex", "comix"])(
    "recovers missing UUIDs using exact %s links and keeps retries idempotent",
    async (provider) => {
      const current = await entry(provider, `native-${provider}`);
      const input = {
        action: "read",
        id: `missing-${provider}`,
        read: read(provider, `native-${provider}`, `event-${provider}`),
      };
      const progress = Schema.decodeUnknownSync(ReadingProgress)(await request(input));
      expect(progress).toMatchObject({ entryId: current.id, chapterNumber: 12, version: 1 });
      expect(await request(input)).toEqual(progress);
      expect(await request({ action: "get", id: input.id })).toBeNull();
      if (provider === "mangadex") {
        const ops = Schema.decodeUnknownSync(Schema.Array(SyncOp))(
          await request({ action: "ops" }),
        );
        const matchingOps = ops.filter((op) => op.opId === input.read.eventId);
        expect(matchingOps).toHaveLength(1);
        expect(matchingOps[0]?.payload.entryId).toBe(current.id);
      }
    },
  );

  it("keeps unresolved reads failed rather than inventing an entry or stealing a cross-provider ID", async () => {
    await entry("mangadex", "md-only");
    const input = {
      action: "read",
      id: "missing-unresolved",
      read: read("comix", "md-only", "unresolved-event"),
    };
    expect(await request(input, 500)).toEqual({
      error: "Canonical entry not found: missing-unresolved",
    });
    expect(await request({ action: "get", id: input.id })).toBeNull();
  });

  it("does not redirect an existing live entry with a conflicting native binding", async () => {
    const first = await entry("comix", "first");
    await entry("comix", "second");
    expect(
      await request(
        { action: "read", id: first.id, read: read("comix", "second", "conflict-event") },
        500,
      ),
    ).toEqual({ error: `Registry entry ${first.id} has comix:first, not second` });
  });

  it("still follows tombstoned entries to their live successors", async () => {
    const old = await entry("comix", "recreated");
    await request({ action: "nuke", id: old.id });
    const current = await entry("comix", "recreated");
    expect(current.id).not.toBe(old.id);
    expect(
      await request({
        action: "read",
        id: old.id,
        read: read("comix", "recreated", "recreated-event"),
      }),
    ).toMatchObject({ entryId: current.id, chapterNumber: 12 });
  });

  it("rolls back a rejected resurrection but still allows a matching read", async () => {
    const deleted = await entry("comix", "deleted-original");
    await request({ action: "nuke", id: deleted.id });
    const before = await request({ action: "snapshot" });
    const tombstoned = await snapshotEntry(deleted.id);
    expect(tombstoned["id"]).toBe(deleted.id);
    expect(isFiniteNumber(tombstoned["tombstoned_at"])).toBe(true);

    expect(
      await request(
        {
          action: "read",
          id: deleted.id,
          read: read("comix", "deleted-wrong", "rejected-resurrection"),
        },
        500,
      ),
    ).toEqual({
      error: `Registry entry ${deleted.id} has comix:deleted-original, not deleted-wrong`,
    });
    expect(await request({ action: "snapshot" })).toEqual(before);

    expect(
      await request({
        action: "read",
        id: deleted.id,
        read: read("comix", "deleted-original", "accepted-resurrection"),
      }),
    ).toMatchObject({ entryId: deleted.id, chapterNumber: 12, version: 1 });
    expect((await snapshotEntry(deleted.id))["tombstoned_at"]).toBeNull();
  });

  it("does not retain an observed provider link when the event belongs to another entry", async () => {
    const first = await entry("comix", "event-owner");
    await request({
      action: "read",
      id: first.id,
      read: read("comix", "event-owner", "owned-event"),
    });
    const second = await entry("anilist", "unlinked-entry");
    const before = await request({ action: "snapshot" });

    expect(
      await request(
        {
          action: "read",
          id: second.id,
          read: read("mangadex", "new-md-link", "owned-event"),
        },
        500,
      ),
    ).toEqual({ error: "Read event owned-event belongs to another entry" });
    expect(await request({ action: "snapshot" })).toEqual(before);
  });
});
