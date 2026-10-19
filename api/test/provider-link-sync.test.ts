/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { Schema } from "effect";
import { RegistryEntry, RegistryListResponse } from "@manifold/contract";
import { isJsonValue, type JsonValue } from "@manifold/json";
import { newId } from "../src/effect-host";

// Only fixture controls bypass HTTP routing. All writes/assertions under test use
// the production Worker, including its real error/status mapping and auth.
const fixture = `
import worker from './src/index.ts';
import { ManifoldSync } from './src/manifold-sync.ts';
export class TestSync extends ManifoldSync {
  async pause() { this.ctx.storage.kv.put('registry_sync_paused', true); }
  async fault(enabled) {
    this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fail_link_event');
    if (enabled) this.ctx.storage.sql.exec(
      "CREATE TRIGGER fail_link_event BEFORE INSERT ON list_events WHEN NEW.kind = 'link.set' BEGIN SELECT RAISE(ABORT, 'fixture link event failure'); END"
    );
  }
}
export default { async fetch(request, env, ctx) {
  const sync = env.MANIFOLD_SYNC.getByName('default');
  await sync.pause();
  const url = new URL(request.url);
  if (url.pathname === '/fixture/fault') {
    await sync.fault(url.searchParams.get('enabled') === 'true');
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
    worker = new Miniflare(
      convertV4MiniflareOptions({
        name: "provider-links",
        modules: true,
        script: built.outputFiles[0].text,
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
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
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

  it("persists, lists, conflict-checks and unlinks native MangaNato slugs", async () => {
    const target = await create();
    const other = await create();
    const binding = { provider: "manganato", externalId: "pseudo-harem", onConflict: "reject" };
    await request(`/v1/entries/${target.id}/providers`, binding);
    const registry = Schema.decodeUnknownSync(RegistryListResponse)(await request("/v1/registry"));
    expect(registry.entries.find((row) => row.id === target.id)?.providers).toMatchObject([
      { provider: "manganato", externalId: "pseudo-harem" },
    ]);
    await request(`/v1/entries/${other.id}/providers`, binding, 500);
    expect(await entry(other.id)).toMatchObject({ providers: [] });
    expect(await request(`/v1/entries/${target.id}/unlink/manganato`, {})).toMatchObject({
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
          body: JSON.stringify({
            provider: "kagane",
            externalId: "competing",
            onConflict: "reject",
          }),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 500]);
    const loser = responses.find((response) => response.status === 500)!;
    expect(await loser.text()).toContain("Provider link conflict");
    const rows = await Promise.all(
      [a, b].map(async (target) => Schema.decodeUnknownSync(RegistryEntry)(await entry(target.id))),
    );
    expect(rows.map((row) => row.providers.length).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await events()).not.toEqual(beforeEvents);
    const before = await snapshot();
    const unlinked = rows.find((row) => row.providers.length === 0)!;
    await link(unlinked.id, "competing", "reject", 500);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects differing target binding and invalid policies without side effects", async () => {
    const target = await create();
    await link(target.id, "original");
    const before = await snapshot();
    expect(JSON.stringify(await link(target.id, "different", "reject", 500))).toContain(
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
    expect(JSON.stringify(await link(newId(), "missing", "reject", 500))).toContain(
      "Active canonical entry not found",
    );
    await link(dead.id, "reserved", "reject", 500);
    await link(dead.id, "new", "reject", 500);
    expect(JSON.stringify(await link(active.id, "reserved", "reject", 500))).toContain(
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

  it("rolls back link inserts, replacement and stolen-owner deletion when event insertion fails", async () => {
    const a = await create();
    const b = await create();
    const fresh = await create();
    await link(a.id, "rollback-a");
    await link(b.id, "rollback-b");
    const before = await snapshot();
    await request("/fixture/fault?enabled=true");
    try {
      expect(JSON.stringify(await link(fresh.id, "rollback-new", "reject", 500))).toContain(
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
});
