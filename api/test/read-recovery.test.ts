/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
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
import api from './src/index.ts';
import { migrate } from './src/manifold-sync/migrate.ts';
import { restoreRegistry } from './src/manifold-sync/backup.ts';
import { REGISTRY_BACKUP_TABLE_NAMES, REGISTRY_BACKUP_TABLE_COLUMNS } from './src/registry-backup.ts';
export class TestSync extends ManifoldSync {
  async pause() { this.ctx.storage.kv.put('registry_sync_paused', true); }
  async snapshot() {
    return Object.fromEntries(REGISTRY_BACKUP_TABLE_NAMES.map(table =>
      [table, this.ctx.storage.sql.exec('SELECT * FROM ' + table).toArray()]));
  }
  async seed(tables) {
    for (const table of REGISTRY_BACKUP_TABLE_NAMES) {
      const columns = REGISTRY_BACKUP_TABLE_COLUMNS[table];
      for (const row of tables[table] ?? []) {
        this.ctx.storage.sql.exec('INSERT INTO ' + table + ' (' + columns.join(',') +
          ') VALUES (' + columns.map(() => '?').join(',') + ')', ...columns.map(c => row[c]));
      }
    }
  }
  async upgrade() { migrate({ctx:this.ctx, env:this.env}); }
  async restore(tables) { restoreRegistry({ctx:this.ctx, env:this.env}, {tables}); }
}
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname.startsWith('/v1/')) {
    return api.fetch(request, env, ctx);
  }
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
      case 'seed': result = await sync.seed(input.tables); break;
      case 'upgrade': result = await sync.upgrade(); break;
      case 'restore': result = await sync.restore(input.tables); break;
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
    const row = (await snapshotEntries()).find((row) => row["id"] === id);
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
        bindings: { MANIFOLD_TOKEN: "fixture-token" },
        durableObjects: { MANIFOLD_SYNC: { className: "TestSync", useSQLite: true } },
      }),
    );
  }, 30_000);
  afterAll(async () => {
    await worker?.dispose();
  });

  it.each(["mangadex"])(
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
    await entry("anilist", "canonical-only");
    const input = {
      action: "read",
      id: "missing-unresolved",
      read: read("mangadex", "canonical-only", "unresolved-event"),
    };
    expect(await request(input, 500)).toEqual({
      error: "Canonical entry not found: missing-unresolved",
    });
    expect(await request({ action: "get", id: input.id })).toBeNull();
  });

  it("does not redirect an existing live entry with a conflicting native binding", async () => {
    const first = await entry("mangadex", "first");
    await entry("mangadex", "second");
    expect(
      await request(
        { action: "read", id: first.id, read: read("mangadex", "second", "conflict-event") },
        500,
      ),
    ).toEqual({ error: `Registry entry ${first.id} has mangadex:first, not second` });
  });

  it("still follows tombstoned entries to their live successors", async () => {
    const old = await entry("mangadex", "recreated");
    await request({ action: "nuke", id: old.id });
    const current = await entry("mangadex", "recreated");
    expect(current.id).not.toBe(old.id);
    expect(
      await request({
        action: "read",
        id: old.id,
        read: read("mangadex", "recreated", "recreated-event"),
      }),
    ).toMatchObject({ entryId: current.id, chapterNumber: 12 });
  });

  it("rolls back a rejected resurrection but still allows a matching read", async () => {
    const deleted = await entry("mangadex", "deleted-original");
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
          read: read("mangadex", "deleted-wrong", "rejected-resurrection"),
        },
        500,
      ),
    ).toEqual({
      error: `Registry entry ${deleted.id} has mangadex:deleted-original, not deleted-wrong`,
    });
    expect(await request({ action: "snapshot" })).toEqual(before);

    expect(
      await request({
        action: "read",
        id: deleted.id,
        read: read("mangadex", "deleted-original", "accepted-resurrection"),
      }),
    ).toMatchObject({ entryId: deleted.id, chapterNumber: 12, version: 1 });
    expect((await snapshotEntry(deleted.id))["tombstoned_at"]).toBeNull();
  });

  it("does not retain an observed provider link when the event belongs to another entry", async () => {
    const first = await entry("mangadex", "event-owner");
    await request({
      action: "read",
      id: first.id,
      read: read("mangadex", "event-owner", "owned-event"),
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

  it("retires stored Comix identities on upgrade and restore without losing library or read history", async () => {
    await request({
      action: "seed",
      tables: {
        canonical_entries: [
          {
            id: "retired-only",
            provider: "comix",
            provider_id: "old-id",
            title: "Retired",
            created_at: 1,
            updated_at: 2,
            tombstoned_at: 99,
          },
          {
            id: "mixed",
            provider: "local",
            provider_id: "mixed-id",
            title: "Mixed",
            created_at: 3,
            updated_at: 4,
            tombstoned_at: null,
          },
        ],
        provider_links: [
          {
            entry_id: "retired-only",
            provider: "comix",
            external_id: "old-id",
            title: null,
            updated_at: 2,
          },
          {
            entry_id: "mixed",
            provider: "comix",
            external_id: "mixed-id",
            title: null,
            updated_at: 4,
          },
          {
            entry_id: "mixed",
            provider: "mangadex",
            external_id: "live-id",
            title: null,
            updated_at: 4,
          },
        ],
        progress_state: [
          {
            entry_id: "retired-only",
            chapter_key: "comix:chapter-12",
            chapter_number: 12.5,
            volume_number: 3,
            provider: "comix",
            source_chapter_id: "chapter-12",
            read_at: 7,
            version: 9,
          },
          {
            entry_id: "mixed",
            chapter_key: "mangadex:live-chapter",
            chapter_number: 4,
            volume_number: null,
            provider: "mangadex",
            source_chapter_id: "live-chapter",
            read_at: 8,
            version: 2,
          },
        ],
        read_events: [
          {
            event_id: "retired-event",
            entry_id: "retired-only",
            chapter_key: "comix:chapter-12",
            read_at: 7,
          },
        ],
        list_state: [
          {
            entry_id: "retired-only",
            status: "reading",
            score: 8.5,
            notes: "Keep this",
            started_at: "2026-01-01",
            completed_at: null,
            volume_progress: 3,
            media_list_entry_id: null,
            updated_at: 5,
          },
        ],
      },
    });
    const before = await request({ action: "snapshot" });
    if (!isJsonObject(before)) {
      throw new Error("Invalid snapshot");
    }
    await request({ action: "upgrade" });
    const after = await request({ action: "snapshot" });
    if (!isJsonObject(after)) {
      throw new Error("Invalid snapshot");
    }
    expect(after.list_state).toEqual(before.list_state);
    expect(after.sync_ops).toEqual(before.sync_ops);
    expect(after.md_status_queue).toEqual(before.md_status_queue);
    expect(after.list_events).toEqual(before.list_events);
    expect(arrayField(after, "canonical_entries")).toHaveLength(
      arrayField(before, "canonical_entries")!.length,
    );
    expect(await snapshotEntry("retired-only")).toEqual({
      id: "retired-only",
      provider: "local",
      provider_id: "retired-only",
      title: "Retired",
      created_at: 1,
      updated_at: 2,
      tombstoned_at: 99,
    });
    expect(arrayField(after, "provider_links")).toEqual(
      arrayField(before, "provider_links")!.filter(
        (row) => isJsonObject(row) && row.provider !== "comix",
      ),
    );
    const historicalKey = "historical:636F6D69783A636861707465722D3132";
    expect(arrayField(after, "progress_state")).toEqual(
      arrayField(before, "progress_state")!.map((row) =>
        isJsonObject(row) && row.entry_id === "retired-only"
          ? { ...row, chapter_key: historicalKey, provider: null, source_chapter_id: null }
          : row,
      ),
    );
    expect(arrayField(after, "read_events")).toEqual(
      arrayField(before, "read_events")!.map((row) =>
        isJsonObject(row) && row.event_id === "retired-event"
          ? { ...row, chapter_key: historicalKey }
          : row,
      ),
    );
    await request({ action: "upgrade" });
    expect(await request({ action: "snapshot" })).toEqual(after);
    await request({ action: "restore", tables: before });
    expect(await request({ action: "snapshot" })).toEqual(after);
  });

  it("rejects retired-provider HTTP writes before they can resurrect entries or observe links", async () => {
    const target = await entry("anilist", "retired-write-target");
    await request({ action: "nuke", id: target.id });
    const before = await request({ action: "snapshot" });
    const identity = { provider: "comix", providerId: "old-id", title: "Retired" };
    for (const [path, body] of [
      ["/v1/registry/ingest", identity],
      ["/v1/canonical/resolve", identity],
      [`/v1/entries/${target.id}/providers`, { provider: "comix", externalId: "old-id" }],
      [`/v1/entries/${target.id}/read`, read("comix", "old-id", "late-event")],
    ] as const) {
      const response = await worker.dispatchFetch(`https://manifold.jfa.dev${path}`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(400);
    }
    expect(await request({ action: "snapshot" })).toEqual(before);
  });
});
