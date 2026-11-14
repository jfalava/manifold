/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Schema } from "effect";
import { EventsListResponse, RegistryEntry, RegistryListResponse } from "@manifold/contract";
import { isJsonValue, type JsonValue } from "@manifold/json";
import { toJsonText } from "@manifold/json/text";
import { newId } from "../src/effect-host";

// Only fixture controls bypass HTTP routing. All writes/assertions under test use
// the production Worker, including its real error/status mapping and auth.
const fixture = `
import worker from './src/index.ts';
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async pause() { this.ctx.storage.kv.put('registry_sync_paused', true); }
  async fault(enabled, kind) {
    this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fail_link_event');
    if (!['link.set', 'link.remove', 'candidate.ingest', 'list.state', 'list.nuke'].includes(kind)) throw new Error('Unknown fixture event kind');
    if (enabled) this.ctx.storage.sql.exec(
      "CREATE TRIGGER fail_link_event BEFORE INSERT ON list_events WHEN NEW.kind = '" + kind + "' BEGIN SELECT RAISE(ABORT, 'fixture link event failure'); END"
    );
  }
}
export default { async fetch(request, env, ctx) {
  const sync = env.MANIFOLD_SYNC.getByName('default');
  await sync.pause();
  const url = new URL(request.url);
  if (url.pathname === '/fixture/fault') {
    await sync.fault(url.searchParams.get('enabled') === 'true', url.searchParams.get('kind') ?? 'link.set');
    return Response.json({ ok: true });
  }
  return worker.fetch(request, env, ctx);
} };`;

describe("entry-targeted provider links over SQLite HTTP", () => {
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
        name: "provider-links",
        modules: true,
        script: output.text,
        compatibilityDate: "2026-08-28",
        durableObjects: { MANIFOLD_SYNC: { className: "TestSync", useSQLite: true } },
        bindings: { MANIFOLD_TOKEN: "fixture-token" },
        outboundService: async () => {
          throw new Error("Unexpected outbound request");
        },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  const request = async (path: string, body?: JsonValue, status = 200): Promise<JsonValue> => {
    const response = await worker.dispatchFetch(`https://manifold.jfa.dev${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      ...(body !== undefined && { body: toJsonText(body) }),
    });

    const value = await response.json();
    expect(response.status, toJsonText(value)).toBe(status);

    if (!isJsonValue(value)) {
      throw new Error("Invalid JSON response");
    }

    return value;
  };

  const create = async () => {
    const id = newId();

    return Schema.decodeUnknownSync(RegistryEntry)(
      await request(
        "/v1/entries",
        {
          id,
          provider: "local",
          providerId: id,
          title: "Local title",
        },
        201,
      ),
    );
  };

  const entry = (id: string) => request(`/v1/entries/${id}`);
  const events = () => request("/v1/events?limit=500");

  const snapshot = async () => ({
    registry: await request("/v1/registry"),
    events: await events(),
  });

  const link = (
    id: string,
    externalId: string,
    onConflict: string | undefined = "reject",
    status = 200,
  ) =>
    request(
      `/v1/entries/${id}/providers`,
      {
        provider: "kagane",
        externalId,
        title: "Provider title",
        sourceName: "Kodansha Comics",
        ...(onConflict !== undefined && { onConflict }),
      },
      status,
    );

  it("searches titles longer than SQLite's LIKE pattern limit and matches % and _ literally", async () => {
    const title = "I Got Caught Up In a Hero Summons, but the Other World was at Peace! 100%_done";
    const id = newId();
    await request("/v1/entries", { id, provider: "local", providerId: id, title }, 201);

    const search = async (q: string) =>
      Schema.decodeUnknownSync(Schema.Struct({ entries: Schema.Array(RegistryEntry) }))(
        await request(`/v1/registry/search?q=${encodeURIComponent(q)}&limit=25`),
      ).entries.map((row) => row.id);

    expect(await search(title)).toContain(id);
    expect(await search("other world WAS at peace")).toContain(id);
    expect(await search("100%_done")).toContain(id);
    expect(await search("100x_done")).not.toContain(id);
    expect(await search("Peace!%")).not.toContain(id);
  });

  it("anchors a linkless local UUID, retains/reads Kagane and replays without writes", async () => {
    const target = await create();
    expect(target.providers).toEqual([]);
    const linked = await link(target.id, "book/replay");
    expect(linked).toMatchObject({
      id: target.id,
      provider: "local",
      title: "Local title",
      providers: [
        {
          provider: "kagane",
          externalId: "book/replay",
          title: "Provider title",
          sourceName: "Kodansha Comics",
        },
      ],
    });
    expect(await entry(target.id)).toEqual(linked);
    const before = await snapshot();

    const listed = Schema.decodeUnknownSync(RegistryListResponse)(before.registry).entries.find(
      (row) => row.id === target.id,
    );

    expect(listed?.providers).toMatchObject([{ sourceName: "Kodansha Comics" }]);
    expect(
      await request(`/v1/entries/${target.id}/providers`, {
        provider: "kagane",
        externalId: "book/replay",
        title: "Do not update",
        sourceName: "Do not update the source either",
        onConflict: "reject",
      }),
    ).toEqual(linked);
    expect(await snapshot()).toEqual(before);
    expect(await request(`/v1/entries/${target.id}/unlink/kagane`, {})).toMatchObject({
      providers: [],
    });
  });

  it.each([
    ["manganato", "pseudo-harem"],
    ["xcomic", "5ovmw"],
  ])("persists, lists, conflict-checks and unlinks native %s IDs", async (provider, externalId) => {
    const target = await create();
    const other = await create();
    const binding = { provider, externalId, sourceName: "Native origin", onConflict: "reject" };
    await request(`/v1/entries/${target.id}/providers`, binding);
    const registry = Schema.decodeUnknownSync(RegistryListResponse)(await request("/v1/registry"));
    expect(registry.entries.find((row) => row.id === target.id)?.providers).toMatchObject([
      { provider, externalId, sourceName: "Native origin" },
    ]);
    await request(`/v1/entries/${other.id}/providers`, binding, 500);
    expect(await entry(other.id)).toMatchObject({ providers: [] });
    expect(await request(`/v1/entries/${target.id}/unlink/${provider}`, {})).toMatchObject({
      providers: [],
    });
  });

  it("preserves omitted source metadata only when the provider identity is unchanged", async () => {
    const target = await create();
    await link(target.id, "source-original");

    const same = await request(`/v1/entries/${target.id}/providers`, {
      provider: "kagane",
      externalId: "source-original",
      onConflict: "replace",
    });

    expect(Schema.decodeUnknownSync(RegistryEntry)(same).providers[0]?.sourceName).toBe(
      "Kodansha Comics",
    );

    const replaced = await request(`/v1/entries/${target.id}/providers`, {
      provider: "kagane",
      externalId: "source-replacement",
      onConflict: "replace",
    });

    expect(Schema.decodeUnknownSync(RegistryEntry)(replaced).providers).toEqual([
      expect.objectContaining({ externalId: "source-replacement" }),
    ]);
    expect(
      Schema.decodeUnknownSync(RegistryEntry)(replaced).providers[0]?.sourceName,
    ).toBeUndefined();
  });

  it("allows only one of two competing targets, without minting or stealing", async () => {
    const a = await create();
    const b = await create();
    const beforeEvents = await events();

    const responses = await Promise.all(
      [a, b].map((target) =>
        worker.dispatchFetch(`https://manifold.jfa.dev/v1/entries/${target.id}/providers`, {
          method: "POST",
          headers: { authorization: "Bearer fixture-token" },
          body: toJsonText({
            provider: "kagane",
            externalId: "competing",
            onConflict: "reject",
          }),
        }),
      ),
    );

    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 500]);
    const loser = responses.find((response) => response.status === 500);

    if (!loser) {
      throw new Error("Expected one rejected link response");
    }

    expect(await loser.text()).toContain("Provider link conflict");

    const rows = await Promise.all(
      [a, b].map(async (target) => Schema.decodeUnknownSync(RegistryEntry)(await entry(target.id))),
    );

    expect(rows.map((row) => row.providers.length).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await events()).not.toEqual(beforeEvents);
    const before = await snapshot();
    const unlinked = rows.find((row) => row.providers.length === 0);

    if (!unlinked) {
      throw new Error("Expected one unlinked entry");
    }

    await link(unlinked.id, "competing", "reject", 500);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects differing target binding and invalid policies without side effects", async () => {
    const target = await create();
    await link(target.id, "original");
    const before = await snapshot();
    expect(toJsonText(await link(target.id, "different", "reject", 500))).toContain(
      "different kagane binding",
    );
    await link(target.id, "different", "overwrite", 400);
    expect(await snapshot()).toEqual(before);
  });

  it("requires an active target and reserves tombstoned owners", async () => {
    const dead = await create();
    const active = await create();
    await link(dead.id, "reserved");
    await request(`/v1/entries/${dead.id}/delete`, {});
    const before = await snapshot();
    expect(toJsonText(await link(newId(), "missing", "reject", 500))).toContain(
      "Active canonical entry not found",
    );
    await link(dead.id, "reserved", "reject", 500);
    await link(dead.id, "new", "reject", 500);
    expect(toJsonText(await link(active.id, "reserved", "reject", 500))).toContain(
      "already owned by",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("keeps omitted/replace manual reassignment semantics", async () => {
    const a = await create();
    const b = await create();
    await link(a.id, "manual-a");
    await link(b.id, "manual-b");
    await request(`/v1/entries/${b.id}/providers`, {
      provider: "kagane",
      externalId: "manual-a",
    });
    expect(await entry(a.id)).toMatchObject({ providers: [] });
    expect(await entry(b.id)).toMatchObject({ providers: [{ externalId: "manual-a" }] });
    await link(a.id, "manual-a", "replace");
    expect(await entry(b.id)).toMatchObject({ providers: [] });
    expect(await entry(a.id)).toMatchObject({ providers: [{ externalId: "manual-a" }] });
  });

  it("hides the failure detail of a 500 from callers without a bearer", async () => {
    const response = await worker.dispatchFetch(
      "https://manifold.jfa.dev/v1/auth/anilist/callback?state=unknown-state&code=x",
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });

  it("rolls back link inserts, replacement and stolen-owner deletion when event insertion fails", async () => {
    const a = await create();
    const b = await create();
    const fresh = await create();
    await link(a.id, "rollback-a");
    await link(b.id, "rollback-b");
    const before = await snapshot();
    await request("/fixture/fault?enabled=true");

    try {
      expect(toJsonText(await link(fresh.id, "rollback-new", "reject", 500))).toContain(
        "fixture link event failure",
      );
      await link(b.id, "rollback-a", "replace", 500);
      expect(await snapshot()).toEqual(before);
    } finally {
      await request("/fixture/fault?enabled=false");
    }

    await link(b.id, "rollback-a", "replace");
    expect(await entry(a.id)).toMatchObject({ providers: [] });
  });

  it.each([
    {
      name: "an unlink",
      kind: "link.remove",
      write: (id: string) => request(`/v1/entries/${id}/unlink/kagane`, {}, 500),
    },
    {
      name: "a candidate ingest into an existing entry",
      kind: "candidate.ingest",
      write: () =>
        request(
          "/v1/registry/ingest",
          {
            provider: "kagane",
            providerId: "atomic-kept",
            title: "Candidate title",
            links: [{ provider: "mangadex", externalId: "atomic-added" }],
          },
          500,
        ),
    },
    {
      name: "a candidate ingest that mints an entry",
      kind: "candidate.ingest",
      write: () =>
        request(
          "/v1/registry/ingest",
          { provider: "kagane", providerId: "atomic-minted", title: "Candidate title" },
          500,
        ),
    },
    {
      name: "a list-state write",
      kind: "list.state",
      write: (id: string) =>
        request(`/v1/entries/${id}/list-state`, { status: "completed", score: 9 }, 500),
    },
    {
      name: "a nuke",
      kind: "list.nuke",
      write: (id: string) => request(`/v1/entries/${id}/delete`, {}, 500),
    },
  ])("leaves no partial write when the event insert of $name fails", async ({ kind, write }) => {
    const target = await create();
    await link(target.id, "atomic-kept", "replace");
    await request(`/v1/entries/${target.id}/list-state`, { status: "reading" });

    const state = async () => ({
      ...(await snapshot()),
      list: await request(`/v1/entries/${target.id}/list-state`),
      ops: await request("/v1/ops"),
    });

    const before = await state();
    await request(`/fixture/fault?enabled=true&kind=${kind}`);

    try {
      await write(target.id);
      expect(await state()).toEqual(before);
    } finally {
      await request("/fixture/fault?enabled=false");
    }
  });

  it("reports how many events match the filter when the list holds only the newest", async () => {
    const target = await create();
    await link(target.id, "total-a", "replace");
    await link(target.id, "total-b", "replace");
    await link((await create()).id, "total-c", "replace");

    const list = async (query: string) =>
      Schema.decodeUnknownSync(EventsListResponse)(await request(`/v1/events?${query}`));

    const all = await list("limit=500");
    const own = await list(`entryId=${target.id}&limit=500`);
    expect(own.events.length).toBeGreaterThan(1);
    expect(all.events.length).toBeGreaterThan(own.events.length);
    expect(all.events.length).toBeLessThan(500);

    const newest = await list("limit=1");
    expect(newest.events).toHaveLength(1);
    expect(newest.total).toBe(all.events.length);
    expect((await list(`entryId=${target.id}&limit=1`)).total).toBe(own.events.length);
  });
});
