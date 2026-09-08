import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (flags: string[], scenario = "normal") =>
  spawnSync(
    "bun",
    [
      "-e",
      `
  import { BunServices } from '@effect/platform-bun';
  import { Effect } from 'effect';
  import { Command } from 'effect/unstable/cli';
  import { makeRootCommand } from './src/cli';
  for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
  process.env.MANIFOLD_TOKEN = 'fake';
  const row = (id, providers, tombstoned = false) => ({
    id: 'entry-' + id, provider: 'anilist', providerId: String(id), title: 'Registry title',
    providers: providers.map(([provider, externalId]) => ({ provider, externalId, updatedAt: 1 })),
    createdAt: 1, updatedAt: 1, tombstoned,
  });
  const scenario = ${JSON.stringify(scenario)};
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    console.log('REQUEST', init.method ?? 'GET', url.pathname + url.search);
    if (url.pathname.endsWith('/registry')) {
      if (scenario === 'pagination' && url.searchParams.get('offset') === '0') {
        return Response.json({ entries: Array.from({length: 5000}, (_, i) => row(100 + i, [['mal', String(1000 + i)]])) });
      }
      return Response.json({ entries: [
        row(42, [['anilist', '42']]),
        row(43, [['anilist', '43']]),
        row(44, [['anilist', '44']], true),
        row(45, [['anilist', '45'], ['mal', scenario === 'conflict' ? '77' : '99']]),
        row(46, [['mangadex', 'md-46']]),
      ] });
    }
    if (url.hostname === 'graphql.anilist.co') {
      const id = JSON.parse(String(init.body)).variables.id;
      console.log('LOOKUP', id);
      if (scenario === 'unavailable') return new Response('Blocked', {status: 403});
      return Response.json({ data: { Media: {
        id, idMal: id === 42 || scenario === 'duplicate' ? 77 : null, title: { romaji: 'Provider title' },
      } } });
    }
    if (url.pathname.endsWith('/registry/ingest')) {
      console.log('WRITE', init.body);
      return Response.json(row(42, [['anilist', '42'], ['mal', '77']]));
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    await Effect.runPromise(Command.runWith(makeRootCommand(), { version: 'test' })(
      ${JSON.stringify(["registry", "mal", "--delay", "0", ...flags])}
    ).pipe(Effect.provide(BunServices.layer)));
  } catch (error) { console.error(error); process.exitCode = 1; }
`,
    ],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
  );

describe("registry mal CLI", () => {
  it("audits without writes, skips linked/tombstoned rows and reports missing mappings", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WOULD LINK entry-42 anilist:42 → mal:77");
    expect(result.stdout).toContain("UNMAPPED entry-43");
    expect(result.stdout).not.toContain("WRITE");
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42", "LOOKUP 43"]);
  });

  it("applies proven links through ingestion without changing list state", () => {
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'WRITE {"provider":"anilist","providerId":"42","title":"Registry title","links":[{"provider":"mal","externalId":"77"}]}',
    );
    expect(result.stdout).not.toContain("list-state");
    expect(result.stdout).not.toContain("/providers");
  });

  it.each(["conflict", "duplicate"])(
    "reports %s ownership rather than stealing links",
    (scenario) => {
      const result = run([], scenario);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("already belongs to");
      expect(result.stdout).not.toContain("WRITE");
    },
  );

  it("pages the whole registry before applying a lookup limit", () => {
    const result = run(["--limit", "1"], "pagination");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("offset=5000");
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42"]);
  });

  it("reports AniList failure instead of treating it as an absent mapping", () => {
    const result = run(["--apply"], "unavailable");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("2 errors");
    expect(result.stdout).not.toContain("WRITE");
  });
});
