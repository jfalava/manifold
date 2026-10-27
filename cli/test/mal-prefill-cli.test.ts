/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics schemaSync:off */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (
  flags: string[],
  scenario = "normal",
  checkpoint?: { outcome: string; apply: boolean; searchPolicy?: string; report?: string },
) => {
  const directory = mkdtempSync(join(tmpdir(), "mal-prefill-cli-"));
  const reportPath = join(directory, "report.jsonl");
  const resumePath = join(directory, "resume.jsonl");
  try {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
  import { BunServices } from '@effect/platform-bun';
  import { Effect } from 'effect';
  import { Command } from 'effect/cli';
  import { makeRootCommand } from './src/cli';
  import { openRegistryReport } from './src/registry-report';
  import { writeFileSync } from 'node:fs';
  for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
  process.env.MANIFOLD_TOKEN = 'fake';
  const row = (id, providers, tombstoned = false) => ({
    id: 'entry-' + id, provider: 'anilist', providerId: String(id), title: 'Registry title',
    providers: providers.map(([provider, externalId]) => ({ provider, externalId, updatedAt: 1 })),
    createdAt: 1, updatedAt: 1, tombstoned,
  });
  const scenario = ${JSON.stringify(scenario)};
  const checkpoint = ${JSON.stringify(checkpoint) ?? "undefined"};
  if (checkpoint) {
    if (checkpoint.report) writeFileSync(${JSON.stringify(resumePath)}, checkpoint.report);
    else {
      const fixture = openRegistryReport('mal', checkpoint.apply, {apiOrigin: 'https://registry.test'}, ${JSON.stringify(resumePath)});
      fixture.entry(row(42, [['anilist', '42']]), {outcome: checkpoint.outcome,
        ...(checkpoint.searchPolicy && {searchPolicy: checkpoint.searchPolicy})});
      fixture.close();
    }
  }
  let lastLookupAt;
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
      const now = Date.now();
      if (lastLookupAt !== undefined) console.log('LOOKUP_GAP', now - lastLookupAt);
      lastLookupAt = now;
      const id = JSON.parse(String(init.body)).variables.id;
      console.log('LOOKUP', id);
      if (scenario === 'unavailable') return new Response('Blocked', {status: 403});
      return Response.json({ data: { Media: {
        id, idMal: scenario !== 'unmapped' && (id === 42 || scenario === 'duplicate') ? 77 : null, title: { romaji: 'Provider title' },
      } } });
    }
    if (url.pathname.endsWith('/registry/ingest')) {
      console.log('WRITE', init.body);
      return Response.json(row(42, [['anilist', '42'], ['mal', '77']]));
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    await Effect.runPromise(Command.runWith(makeRootCommand("test"), { version: 'test' })(
      ${JSON.stringify(["registry", "mal", "--api-origin", "https://registry.test", "--report", reportPath, ...(checkpoint ? ["--resume", resumePath] : []), ...flags])}
    ).pipe(Effect.provide(BunServices.layer)));
  } catch (error) { console.error(error); process.exitCode = 1; }
`,
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
    );
    return { ...result, report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("registry mal CLI", () => {
  it("audits without writes, skips linked/tombstoned rows and reports missing mappings", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WOULD LINK entry-42 anilist:42 → mal:77");
    expect(result.stdout).toContain("UNMAPPED entry-43");
    expect(result.stdout).not.toContain("WRITE");
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42", "LOOKUP 43"]);
    expect(Number(result.stdout.match(/LOOKUP_GAP (\d+)/)?.[1])).toBeGreaterThanOrEqual(2_400);
    expect(result.stderr).toContain("Load registry rows");
    expect(result.stderr).toContain("Check MAL links");
    expect(result.stdout + result.stderr).not.toContain("eta=");
    expect(result.stdout).not.toContain("│");
  });

  it("does not expose a configurable AniList lookup delay", () => {
    const result = run(["--delay", "0"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/delay|unknown|unrecognized/i);
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
    expect(result.report).toContain('"outcome":"errors"');
    expect(result.report).not.toContain('"outcome":"matched"');
    expect(result.report).toContain('"event":"summary"');
  });

  it("resumes unchanged completed rows before applying --limit", () => {
    const result = run(["--limit", "1"], "normal", { outcome: "matched", apply: false });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 43"]);
    expect(result.report).toContain('"event":"checkpoint"');
    expect(result.report).toContain('"outcome":"unmatched"');
  });

  it("retries errors from the resume report", () => {
    const result = run(["--limit", "1"], "normal", { outcome: "errors", apply: false });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42"]);
    expect(result.report).toContain('"outcome":"matched"');
  });

  it.each([undefined, "old-idmal"])(
    "retries an unmapped checkpoint with policy %s once and skips its refreshed result",
    (searchPolicy) => {
      const refreshed = run(["--limit", "1"], "unmapped", {
        outcome: "unmatched",
        apply: false,
        searchPolicy,
      });
      expect(refreshed.status).toBe(0);
      expect(refreshed.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42"]);
      expect(refreshed.report).toContain('"searchPolicy":"anilist-idmal-v1"');
      expect(refreshed.report).toContain('"outcome":"unmatched"');
      const resumed = run(["--limit", "1"], "unmapped", {
        outcome: "unmatched",
        apply: false,
        report: refreshed.report,
      });
      expect(resumed.status).toBe(0);
      expect(resumed.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 43"]);
      expect(resumed.stdout).not.toContain("WRITE");
    },
    10_000,
  );

  it("rechecks a current-policy dry-run miss when applying", () => {
    const result = run(["--apply", "--limit", "1"], "normal", {
      outcome: "unmatched",
      apply: false,
      searchPolicy: "anilist-idmal-v1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42"]);
    expect(result.stdout).toContain('"externalId":"77"');
    expect(result.stdout).toContain("WRITE");
    expect(result.report).toContain('"applied":true');
  });

  it("rechecks dry-run matches when resuming with --apply", () => {
    const result = run(["--apply", "--limit", "1"], "normal", { outcome: "matched", apply: false });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/LOOKUP \d+/g)).toEqual(["LOOKUP 42"]);
    expect(result.stdout).toContain("WRITE");
    expect(result.report).toContain('"applied":true');
  });
});
