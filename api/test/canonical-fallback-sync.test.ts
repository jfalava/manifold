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
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from "miniflare";
import { Schema } from "effect";
import {
  CanonicalIdentity,
  CanonicalSearchResponse,
  ListState,
  RegistryEntry,
  OpsListResponse,
} from "@manifold/contract";
import { isJsonValue, type JsonValue } from "@manifold/json";

const fixture = `
import { Effect } from 'effect';
import { ManifoldSync } from './src/manifold-sync.ts';
import { handleRegistry } from './src/routes/registry.ts';
import { handleCanonical } from './src/routes/canonical.ts';
export class TestSync extends ManifoldSync {
  async pause() { this.ctx.storage.kv.put('registry_sync_paused', true); }
}
export default { async fetch(request, env) {
  const sync = env.MANIFOLD_SYNC.getByName('default');
  await sync.pause();
  const url = new URL(request.url);
  if (url.pathname === '/ops') return Response.json({ ops: await sync.listOps(undefined, 'anilist') });
  const ctx = { request, env, url, path: url.pathname.split('/').filter(Boolean) };
  try {
    return await Effect.runPromise(handleRegistry(ctx)) ??
      await Effect.runPromise(handleCanonical(ctx)) ?? new Response('Not found', { status: 404 });
  } catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
} };`;

describe("canonical fallback with the real registry", () => {
  let worker: Miniflare;
  let blocked = true;

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
        name: "canonical-fallback",
        modules: true,
        script: built.outputFiles[0].text,
        compatibilityDate: "2026-08-28",
        durableObjects: { MANIFOLD_SYNC: { className: "TestSync", useSQLite: true } },
        bindings: { MANIFOLD_MAL_CLIENT_ID: "client" },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.hostname === "graphql.anilist.co") {
            return blocked
              ? new WorkerResponse("Blocked", { status: 403 })
              : WorkerResponse.json({
                  data: {
                    Media: { id: 42, idMal: 77, title: { romaji: "Recovered AniList title" } },
                  },
                });
          }
          if (url.hostname !== "api.myanimelist.net") {
            throw new Error(`Unexpected upstream ${url}`);
          }
          const manga = { id: 77, title: "MAL title", synopsis: "MAL description" };
          return WorkerResponse.json(
            url.pathname === "/v2/manga" ? { data: [{ node: manga }] } : manga,
          );
        },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  const request = async (path: string, body?: JsonValue): Promise<JsonValue> => {
    const response = await worker.dispatchFetch(`https://fixture.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    });
    expect(response.status).toBe(200);
    const value = await response.json();
    if (!isJsonValue(value)) {
      throw new Error("Invalid response");
    }
    return value;
  };

  it("reuses a linked UUID through search, ingestion, local edit and provider recovery", async () => {
    const original = Schema.decodeUnknownSync(RegistryEntry)(
      await request("/v1/registry/ingest", {
        provider: "anilist",
        providerId: "42",
        title: "Registry title",
        links: [{ provider: "mal", externalId: "77" }],
      }),
    );
    const search = Schema.decodeUnknownSync(CanonicalSearchResponse)(
      await request("/v1/canonical/search?q=title"),
    );
    expect(search.results[0]?.provider).toBe("mal");
    const selected = Schema.decodeUnknownSync(RegistryEntry)(
      await request("/v1/registry/ingest", {
        provider: "mal",
        providerId: "77",
        title: "MAL title",
      }),
    );
    expect(selected.id).toBe(original.id);
    expect(selected.title).toBe("Registry title");
    const state = Schema.decodeUnknownSync(ListState)(
      await request(`/v1/entries/${selected.id}/list-state`, {
        origin: "device",
        appliedRemotely: false,
        status: "completed",
        notes: "Keep this",
        volumeProgress: 9,
      }),
    );
    expect(state).toMatchObject({
      entryId: original.id,
      status: "completed",
      notes: "Keep this",
      volumeProgress: 9,
    });
    const ops = Schema.decodeUnknownSync(OpsListResponse)(await request("/ops"));
    expect(ops.ops).toContainEqual(
      expect.objectContaining({ target: "anilist", kind: "anilist.fields", state: "pending" }),
    );
    const details = () =>
      request(`/v1/entries/${selected.id}/canonical`).then(
        Schema.decodeUnknownSync(CanonicalIdentity),
      );
    expect(await details()).toMatchObject({
      id: original.id,
      provider: "mal",
      providerId: "77",
      metadata: { description: "MAL description" },
    });
    blocked = false;
    expect(await details()).toMatchObject({
      id: original.id,
      provider: "anilist",
      providerId: "42",
    });
    expect(await request(`/v1/entries/${selected.id}/list-state`)).toMatchObject({
      state: {
        entryId: original.id,
        notes: "Keep this",
        status: "completed",
        volumeProgress: 9,
      },
    });
  });

  it("mints MAL-only UUIDs and refuses to merge conflicting provider owners", async () => {
    await request("/v1/registry/ingest", {
      provider: "anilist",
      providerId: "43",
      title: "Another manga",
    });
    const malOnly = Schema.decodeUnknownSync(RegistryEntry)(
      await request("/v1/registry/ingest", {
        provider: "mal",
        providerId: "88",
        title: "Different manga",
      }),
    );
    expect(malOnly.id).not.toBe("mal:88");
    expect(malOnly.provider).toBe("mal");
    const response = await worker.dispatchFetch("https://fixture.test/v1/registry/ingest", {
      method: "POST",
      body: JSON.stringify({
        provider: "anilist",
        providerId: "43",
        title: "Conflicting title",
        links: [{ provider: "mal", externalId: "88" }],
      }),
    });
    expect(response.status).toBe(409);
    expect(await request(`/v1/entries/${malOnly.id}`)).toMatchObject({
      providerId: "88",
      title: "Different manga",
    });
    const recovered = Schema.decodeUnknownSync(RegistryEntry)(
      await request("/v1/registry/ingest", {
        provider: "anilist",
        providerId: "53",
        title: "Recovered title",
        links: [{ provider: "mal", externalId: "88" }],
      }),
    );
    expect(recovered.id).toBe(malOnly.id);
    expect(
      recovered.providers.some(
        (provider) => provider.provider === "anilist" && provider.externalId === "53",
      ),
    ).toBe(true);
    expect(
      (await worker.dispatchFetch("https://fixture.test/v1/entries/missing/canonical")).status,
    ).toBe(404);
  });
});
