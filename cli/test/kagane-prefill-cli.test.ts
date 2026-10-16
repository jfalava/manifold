/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (flags: string[] = [], scenario = "normal") =>
  spawnSync(
    "bun",
    [
      "-e",
      `
  import { BunServices } from '@effect/platform-bun';
  import { Effect } from 'effect';
  import { Command } from 'effect/cli';
  import { makeRootCommand } from './src/cli';
  for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
  process.env.MANIFOLD_TOKEN = 'fake';
  process.env.MANIFOLD_ANILIST_TOKEN = 'fake';
  const scenario = ${JSON.stringify(scenario)};
  const row = (id, title, extra = {}) => ({
    id, title, provider:'local', providerId:id, providers:[], createdAt:1, updatedAt:1,
    state:{entryId:id, status:'reading', updatedAt:1}, ...extra
  });
  const book = (id, title = 'A Story') => ({
    series_id:id, title, source_id:'source-a', current_books:12, format:'MANGA', alternate_titles:[]
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/registry')) {
      if (scenario === 'pagination' && url.searchParams.get('offset') === '0') {
        return Response.json({entries:Array.from({length:5000}, (_, i) => row('linked-'+i, 'Skip', {
          providers:[{provider:'kagane', externalId:'skip-'+i, updatedAt:1}]
        }))});
      }
      console.info('REGISTRY_PAGE', url.searchParams.get('offset'));
      return Response.json({entries:[
        row('target', 'A Story'), row('missing', 'Nothing'),
        row('dead', 'Dead', {tombstoned:true}),
        row('linked', 'Already linked', {providers:[{provider:'kagane', externalId:scenario === 'owned' ? 'series/one' : 'other', updatedAt:1}]}),
        row('paused', 'Paused', {state:{entryId:'paused', status:'on_hold', updatedAt:1}}),
        ...(scenario === 'duplicate' ? [row('second', 'A Story')] : [])
      ]});
    }
    if (url.hostname === 'kagane.org') {
      if (scenario === 'challenge') return new Response('<title>Just a moment...</title>', {status:403, headers:{'cf-mitigated':'challenge'}});
      if (url.pathname.endsWith('/sources/list')) return Response.json({sources:[{source_id:'source-a', source_type:'Official', title:'Example Source'}]});
      if (url.pathname.endsWith('/search/series')) {
        const body = JSON.parse(init.body);
        console.info('SEARCH', body.title, JSON.stringify(body.content_lang));
        if (body.title !== 'A Story') return Response.json({content:[], last:true});
        if (scenario === 'malformed') return Response.json({content:[book('series/one')]});
        if (scenario === 'failure') return new Response('unavailable', {status:503});
        const page = url.searchParams.get('page');
        if (scenario === 'ambiguous') return Response.json({content:[book(page === '0' ? 'series/one' : 'series/two')], last:page !== '0'});
        return Response.json({content:[book('series/one'), book('sequel', 'A Story 2')], last:true});
      }
      if (url.pathname === '/api/v2/series/series%2Fone') return Response.json({
        title:scenario === 'wrong-title' ? 'Different Story' : 'A Story',
        translated_language:scenario === 'wrong-language' ? 'ja' : scenario === 'missing-language' ? undefined : 'en',
        source_id:scenario === 'wrong-source' ? 'source-b' : 'source-a', format:'MANGA',
        edition_info:scenario === 'edition' ? 'Deluxe Edition' : null
      });
    }
    if (url.pathname.endsWith('/providers')) {
      const body = JSON.parse(init.body);
      console.info('WRITE', url.pathname, JSON.stringify(body));
      if (scenario === 'server-conflict') return Response.json({error:'Provider link conflict: already owned by other'}, {status:500});
      return Response.json(row('target', 'A Story', {providers:[{provider:'kagane', externalId:body.externalId, title:body.title, updatedAt:1}]}));
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    await Effect.runPromise(Command.runWith(makeRootCommand('test'), {version:'test'})(
      ${JSON.stringify(["registry", "kagane", ...(flags.includes("--delay") ? [] : ["--delay", "0"]), "--status", "reading", ...flags])}
    ).pipe(Effect.provide(BunServices.layer)));
  } catch (error) { console.error(error); process.exitCode = 1; }
`,
    ],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
  );

describe("registry kagane", () => {
  it("previews unique exact matches, skips dead/linked/status-excluded rows and never writes", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WOULD LINK target → kagane:series/one [Example Source]");
    expect(result.stdout).toContain("UNMATCHED missing");
    expect(result.stdout.match(/SEARCH .*$/gm)).toEqual([
      'SEARCH A Story ["en"]',
      'SEARCH Nothing ["en"]',
    ]);
    expect(result.stdout).not.toContain("WRITE");
  });

  it("applies only to the existing UUID using conflict rejection", () => {
    const result = run(["--apply"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'WRITE /api/v1/entries/target/providers {"provider":"kagane","externalId":"series/one","title":"A Story","onConflict":"reject"}',
    );
    expect(result.stdout).toContain("LINKED target");
    expect(result.stdout).not.toContain("list-state");
  });

  it("does not accept the first match before a competing edition on the next page", () => {
    const result = run(["--apply"], "ambiguous");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("AMBIGUOUS target");
    expect(result.stdout).toContain("series/two");
    expect(result.stdout).not.toContain("WRITE");
  });

  it.each(["wrong-title", "wrong-language", "missing-language", "wrong-source", "edition"])(
    "leaves %s detail candidates unverified",
    (scenario) => {
      const result = run(["--apply"], scenario);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("UNVERIFIED target");
      expect(result.stdout).not.toContain("WRITE");
    },
  );

  it.each(["owned", "duplicate", "server-conflict"])("rejects %s claims", (scenario) => {
    const result = run(["--apply"], scenario);
    expect(result.status).toBe(1);
    if (scenario === "owned") {
      expect(result.stdout).toContain("CONFLICT target");
      expect(result.stdout).not.toContain("WRITE");
    } else if (scenario === "duplicate") {
      expect(result.stdout).toContain("CONFLICT second");
      expect(result.stdout.match(/WRITE /g)).toHaveLength(1);
    } else {
      expect(result.stdout).not.toContain("LINKED target");
      expect(result.stdout).toContain("Provider link conflict");
    }
  });

  it.each(["malformed", "failure", "challenge"])(
    "reports %s as failure, never a catalog miss",
    (scenario) => {
      const result = run(["--apply"], scenario);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("UNMATCHED target");
      expect(result.stdout).not.toContain("WRITE");
      if (scenario === "challenge") {
        expect(result.stdout + result.stderr).toContain("--chrome-cdp-url");
      }
    },
  );

  it("pages before limiting and does no Kagane work for a zero limit", () => {
    const result = run(["--limit", "1"], "pagination");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("REGISTRY_PAGE 5000");
    expect(result.stdout.match(/SEARCH .*$/gm)).toEqual(['SEARCH A Story ["en"]']);
    const empty = run(["--limit", "0"], "challenge");
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).not.toContain("SEARCH");
  });

  it("rejects invalid numeric flags before requesting data", () => {
    for (const flags of [
      ["--delay", "-1"],
      ["--limit", "-1"],
    ]) {
      const result = run(flags);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("REGISTRY_PAGE");
    }
  });
});
