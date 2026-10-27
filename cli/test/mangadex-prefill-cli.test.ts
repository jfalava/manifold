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
  checkpoint?: { outcome: string; apply: boolean; retryable?: boolean; anilistAliases?: boolean },
) => {
  const directory = mkdtempSync(join(tmpdir(), "mangadex-prefill-cli-"));
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
      import { readFileSync } from 'node:fs';
      for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
      process.env.MANIFOLD_TOKEN = 'fake-api-token';
      const row = (id, providers = [['anilist', String(id)]], tombstoned = false) => ({
        id: 'entry-' + id, provider: providers.length ? 'anilist' : 'local', providerId: String(id),
        title: 'Registry title ' + id, providers: providers.map(([provider, externalId]) => ({provider, externalId, updatedAt: 1})),
        createdAt: 1, updatedAt: 1, tombstoned,
      });
      const scenario = ${JSON.stringify(scenario)};
      const checkpoint = ${JSON.stringify(checkpoint) ?? "undefined"};
      let original;
      if (checkpoint) {
        const fixture = openRegistryReport('mangadex', checkpoint.apply, {apiOrigin: 'https://registry.test', anilistAliases: checkpoint.anilistAliases ?? true}, ${JSON.stringify(resumePath)});
        fixture.entry(row(42), {outcome: checkpoint.outcome, retryable: checkpoint.retryable ?? false});
        fixture.close();
        original = readFileSync(${JSON.stringify(resumePath)}, 'utf8');
      }
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/registry') return Response.json({entries: [
          row(42), row(43), row(44), row(45, []), row(46, [['mangadex', 'existing']]), row(47, undefined, true),
        ]});
        if (url.hostname === 'graphql.anilist.co') {
          if (scenario === 'alias-error') return new Response('unavailable', {status: 403});
          return Response.json({data: {Media: {title: {english: 'Alias'}, synonyms: []}}});
        }
        if (url.pathname === '/v1/canonical/mangadex/resolve') {
          const body = JSON.parse(String(init.body));
          console.log('RESOLVE', body.id);
          if (scenario === 'resolve-error') return new Response('unavailable', {status: 403});
          return Response.json({canonicalId: body.id, candidates: [], status: body.id === 'entry-43' ? 'not_found' : body.id === 'entry-44' ? 'ambiguous' : 'matched',
            ...(body.id === 'entry-42' ? {externalId: 'md-42'} : {})});
        }
        if (url.pathname.endsWith('/providers')) {
          console.log('WRITE', init.body);
          if (scenario === 'write-error') return new Response('owned elsewhere', {status: 409});
          return Response.json(row(42, [['anilist', '42'], ['mangadex', 'md-42']]));
        }
        throw new Error('Unexpected request: ' + url);
      };
      try {
        await Effect.runPromise(Command.runWith(makeRootCommand('test'), {version: 'test'})(
          ${JSON.stringify(["registry", "mangadex", "--api-origin", "https://registry.test", "--anilist-token", "fake-anilist-token", "--delay", "0", "--report", reportPath, ...(checkpoint ? ["--resume", resumePath] : []), ...flags])}
        ).pipe(Effect.provide(BunServices.layer)));
      } catch (error) {console.error(error); process.exitCode = 1;}
      if (checkpoint) console.log('RESUME_UNCHANGED', original === readFileSync(${JSON.stringify(resumePath)}, 'utf8'));
    `,
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
    );
    return { ...result, report: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("registry mangadex CLI", () => {
  it("reports matched, unmatched, ambiguous and missing-identity outcomes without writes", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout.match(/RESOLVE entry-\d+/g)).toEqual([
      "RESOLVE entry-42",
      "RESOLVE entry-43",
      "RESOLVE entry-44",
    ]);
    expect(result.stdout).not.toContain("WRITE");
    for (const outcome of ["matched", "unmatched", "ambiguous", "skipped"]) {
      expect(result.report).toContain(`"outcome":"${outcome}"`);
    }
    expect(result.report).toContain('"completed":true');
    expect(result.report).toContain('"anilistAliases":true');
    expect(result.report).not.toContain("fake-api-token");
    expect(result.report).not.toContain("fake-anilist-token");
  }, 10_000);

  it("skips unchanged completed rows before --limit without mutating the resume source", () => {
    const result = run(["--limit", "1"], "normal", { outcome: "matched", apply: false });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/RESOLVE entry-\d+/g)).toEqual(["RESOLVE entry-43"]);
    expect(result.stdout).toContain("RESUME_UNCHANGED true");
    expect(result.report).toContain('"event":"checkpoint"');
  });

  it("retries failed rows in a resume report", () => {
    const result = run(["--limit", "1"], "normal", { outcome: "errors", apply: false });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/RESOLVE entry-\d+/g)).toEqual(["RESOLVE entry-42"]);
    expect(result.report).toContain('"outcome":"matched"');
  });

  it("keeps incomplete alias misses and ambiguities retryable", () => {
    const result = run([], "alias-error");
    expect(result.status).toBe(0);
    expect(result.report).toContain('"outcome":"unmatched"');
    expect(result.report).toContain('"outcome":"ambiguous"');
    expect(result.report.match(/"retryable":true/g)).toHaveLength(3);
  }, 10_000);

  it("retries incomplete search checkpoints", () => {
    const result = run(["--limit", "1"], "normal", {
      outcome: "unmatched",
      apply: false,
      retryable: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/RESOLVE entry-\d+/g)).toEqual(["RESOLVE entry-42"]);
  });

  it("rejects resume settings when AniList alias availability changes", () => {
    const result = run(["--limit", "1"], "normal", {
      outcome: "unmatched",
      apply: false,
      anilistAliases: false,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("anilistAliases differs");
    expect(result.stdout).not.toContain("RESOLVE");
  });

  it("rechecks dry-run matches when applying and rejects link ownership conflicts", () => {
    const result = run(["--apply", "--limit", "1"], "normal", { outcome: "matched", apply: false });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/RESOLVE entry-\d+/g)).toEqual(["RESOLVE entry-42"]);
    expect(result.stdout).toContain('"onConflict":"reject"');
    expect(result.report).toContain('"applied":true');
  });

  it("records resolver errors instead of checkpointing a match", () => {
    const result = run(["--limit", "1"], "resolve-error");
    expect(result.status).toBe(0);
    expect(result.report).toContain('"outcome":"errors"');
    expect(result.report).not.toContain('"outcome":"matched"');
    expect(result.report).toContain('"event":"summary"');
  });

  it("records write errors before aborting and never checkpoints those rows as matched", () => {
    const result = run(["--apply", "--limit", "1"], "write-error");
    expect(result.status).toBe(1);
    expect(result.report).toContain('"outcome":"errors"');
    expect(result.report).not.toContain('"outcome":"matched"');
    expect(result.report).toContain('"completed":false');
    expect(result.report).toContain('"matched":0');
  });
});
