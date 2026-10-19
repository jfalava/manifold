/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (flags: string[] = [], scenario = "normal") => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-kagane-"));
  const report = join(directory, "report.jsonl");
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
  for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
  process.env.MANIFOLD_TOKEN = 'fake';
  process.env.MANIFOLD_ANILIST_TOKEN = 'fake';
  const scenario = ${JSON.stringify(scenario)};
  const identityScenario = scenario.startsWith('identity-');
  let failures = 0;
  let retryNotBefore = 0;
  const row = (id, title, extra = {}) => ({
    id, title, provider:'local', providerId:id, providers:[], createdAt:1, updatedAt:1,
    state:{entryId:id, status:'reading', updatedAt:1}, ...extra
  });
  const book = (id, title = 'A Story') => ({
    series_id:id, title, source_id:'source-a', current_books:12, format:'MANGA', alternate_titles:[]
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.mangadex.org') return new Response('No additional aliases in this fixture', {status:404});
    if (url.pathname.endsWith('/registry')) {
      if (scenario === 'pagination' && url.searchParams.get('offset') === '0') {
        return Response.json({entries:Array.from({length:5000}, (_, i) => row('linked-'+i, 'Skip', {
          providers:[{provider:'kagane', externalId:'skip-'+i, updatedAt:1}]
        }))});
      }
      console.info('REGISTRY_PAGE', url.searchParams.get('offset'));
      return Response.json({entries:[
        row('target', 'A Story', scenario === 'identity-mangadex' ? {providers:[
          {provider:'mangadex', externalId:'461f0cfa-cd72-4d70-bf26-a0279e0aa8fc', updatedAt:1}
        ]} : identityScenario ? {providers:[
          {provider:'anilist', externalId:'123', updatedAt:1},
          ...(scenario === 'identity-shared-conflict' ? [] : [{provider:'mal', externalId:'456', updatedAt:1}])
        ]} : {}), row('missing', 'Nothing'),
        row('dead', 'Dead', {tombstoned:true}),
        row('linked', 'Already linked', {providers:[{provider:'kagane', externalId:scenario === 'owned' ? 'series/one' : 'other', updatedAt:1}]}),
        row('paused', 'Paused', {state:{entryId:'paused', status:'on_hold', updatedAt:1}}),
        ...(scenario === 'duplicate' ? [row('second', 'A Story')] : [])
      ]});
    }
    if (url.hostname === 'kagane.org') {
      if (scenario === 'challenge') return new Response('<title>Just a moment...</title>', {status:403, headers:{'cf-mitigated':'challenge'}});
      if (url.pathname.endsWith('/sources/list')) return Response.json({sources:[
        ...(scenario === 'excluded-catalog' ? [] : [
          {source_id:'source-a', source_type:'Official', title:'Example Source'},
          {source_id:'source-b', source_type:'Official', title:'Kodansha Comics'}
        ]),
        {source_id:'source-md', source_type:'Unofficial', title:'MangaDex'},
        ...(scenario === 'identity-default' ? ['VIZ Media','Manga Up!','Comikey','Crunchyroll','Square Enix Manga'].map((title, i) => ({source_id:'priority-'+i, title})) : [])
      ]});
      if (url.pathname.endsWith('/search/series')) {
        const body = JSON.parse(init.body);
        console.info('SEARCH', body.title, JSON.stringify(body.content_lang));
        console.info('SEARCH_BODY', JSON.stringify(body));
        if (body.title !== 'A Story') return Response.json({content:[], last:true});
        // Deliberately ignore source_id to exercise client-side exclusion too.
        if (scenario.startsWith('excluded-source-')) return Response.json({content:[
          {...book('mangadex-series'), source_id:'source-md'},
          ...(scenario === 'excluded-source-mixed' ? [book('series/one')] : [])
        ], last:true});
        if (scenario === 'malformed') return Response.json({content:[book('series/one')]});
        if (scenario === 'failure') return new Response('unavailable', {status:503});
        if (scenario === 'retry') {
          if (performance.now() < retryNotBefore) return new Response('Retry-After ignored', {status:400});
          if (failures++ < 2) {
            retryNotBefore = performance.now() + (failures === 1 ? 3000 : 1000);
            return new Response('later', {status:failures === 1 ? 429 : 503, headers:{'retry-after':failures === 1 ? '3' : '1'}});
          }
        }
        if (scenario === 'cooldown' || scenario === 'cooldown-date') return new Response('later', {status:429, headers:{'retry-after':scenario === 'cooldown' ? '121' : new Date(Date.now()+180000).toUTCString()}});
        const page = url.searchParams.get('page');
        if (scenario === 'long-search') return Response.json({content:[book('page-'+page, page === '20' ? 'A Story' : 'Unrelated '+page)], last:page === '20', total_pages:21});
        if (scenario === 'stuck-search') return Response.json({content:[book('same')], last:false});
        if (scenario === 'ambiguous') return Response.json({content:[book(page === '0' ? 'series/one' : 'series/two')], last:page !== '0'});
        if (identityScenario) {
          const books = [book('series/one'), {...book('series/two'), source_id:'source-b', current_books:1}];
          if (scenario === 'identity-same-source') books[0].source_id = 'source-b';
          return Response.json({content:books.filter(b => !body.source_id || body.source_id.includes(b.source_id)), last:true});
        }
        return Response.json({content:[book('series/one'), book('sequel', 'A Story 2')], last:true});
      }
      if (url.pathname.startsWith('/api/v2/series/')) return Response.json({
        title:scenario === 'wrong-title' || scenario === 'identity-renamed' ? 'Different Story' : 'A Story',
        translated_language:scenario === 'wrong-language' ? 'ja' : scenario === 'missing-language' ? undefined : 'en',
        source_id:scenario === 'wrong-source' || (identityScenario && (url.pathname.endsWith('two') || scenario === 'identity-same-source')) ? 'source-b' : 'source-a', format:'MANGA',
        edition_info:scenario === 'edition' ? 'Deluxe Edition' : null,
        ...(scenario === 'identity-mangadex' ? {series_links:[{url:'https://mangadex.org/title/'+(url.pathname.endsWith('two') ? '461f0cfa-cd72-4d70-bf26-a0279e0aa8fc' : '1fcbaeb6-add2-49a8-8504-9baf38e51ce5')+'/a-story'}]} : identityScenario && scenario !== 'identity-unproven' ? {series_links:[
          {url:scenario === 'identity-spoof' ? 'https://anilist.co.evil.test/manga/123' : 'https://anilist.co/manga/123'},
          ...(scenario === 'identity-spoof' ? [] : [{url:'https://myanimelist.net/manga/'+((scenario === 'identity-contradiction' || scenario === 'identity-shared-conflict') && url.pathname.endsWith('two') ? '999' : '456')+'/a-story'}])
        ]} : {})
      });
    }
    if (url.pathname.endsWith('/providers')) {
      const body = JSON.parse(init.body);
      console.info('WRITE', url.pathname, JSON.stringify(body));
      if (scenario === 'server-conflict') return Response.json({error:'Provider link conflict: already owned by other'}, {status:500});
      return Response.json(row('target', 'A Story', {providers:[{provider:'kagane', externalId:body.externalId, title:body.title, sourceName:body.sourceName, updatedAt:1}]}));
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    await Effect.runPromise(Command.runWith(makeRootCommand('test'), {version:'test'})(
      ${JSON.stringify(["registry", "kagane", "--report", report, ...(flags.includes("--source-priority") || scenario === "identity-default" ? [] : ["--source-priority", "none"]), ...(flags.includes("--delay") ? [] : ["--delay", "0"]), "--status", "reading", ...flags])}
    ).pipe(Effect.provide(BunServices.layer)));
  } catch (error) { console.error(error); process.exitCode = 1; }
`,
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
    );
    return {
      ...result,
      report: existsSync(report)
        ? readFileSync(report, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

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
    // Omission means unrestricted on Kagane, unlike MangaDex's safe+suggestive default.
    expect(
      [...result.stdout.matchAll(/^SEARCH_BODY (.+)$/gm)].map((match) => JSON.parse(match[1]!)),
    ).toEqual([
      { title: "A Story", content_lang: ["en"] },
      { title: "Nothing", content_lang: ["en"] },
    ]);
    expect(result.stdout).not.toContain("WRITE");
  });

  it("applies only to the existing UUID using conflict rejection", () => {
    const result = run(["--apply"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'WRITE /api/v1/entries/target/providers {"provider":"kagane","externalId":"series/one","title":"A Story","sourceName":"Example Source","onConflict":"reject"}',
    );
    expect(result.stdout).toContain("LINKED target");
    expect(result.stdout).not.toContain("list-state");
  });

  it.each(["mixed", "only"])(
    "excludes MangaDex even with source preference disabled and %s results ignoring the filter",
    (pool) => {
      const result = run(["--apply"], `excluded-source-${pool}`);
      expect(result.status, result.stderr).toBe(0);
      const entry = result.report.find((item) => item.entryId === "target");
      if (pool === "mixed") {
        expect(entry).toMatchObject({ outcome: "matched", selectedId: "series/one" });
        expect(result.stdout).toContain('"externalId":"series/one"');
      } else {
        expect(entry).toMatchObject({ outcome: "unmatched", selectedId: null });
        expect(result.stdout).not.toContain("WRITE");
      }
      expect(entry.candidates.map((candidate) => candidate.id)).not.toContain("mangadex-series");
    },
  );

  it("rejects MangaDex priority and refuses an empty allowed catalog instead of searching unfiltered", () => {
    for (const priority of ["MangaDex", "  mAnGaDeX  ", "Kodansha Comics,MangaDex"]) {
      const result = run(["--apply", "--source-priority", priority]);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("native MangaDex provider");
      expect(result.stdout).not.toContain("REGISTRY_PAGE");
    }
    const empty = run(["--apply"], "excluded-catalog");
    expect(empty.status).toBe(1);
    expect(empty.stdout + empty.stderr).toContain("No non-MangaDex Kagane sources");
    expect(empty.stdout).not.toContain("SEARCH");
    expect(empty.stdout).not.toContain("WRITE");
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
    15_000,
  );

  it("uses source priority only after verifying IDs, not chapter counts or result order", () => {
    const result = run(["--apply", "--source-priority", "Kodansha Comics"], "identity-priority");
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.find((entry) => entry.entryId === "target")).toMatchObject({
      outcome: "matched",
      selectedId: "series/two",
    });
    expect(result.stdout).toContain('"externalId":"series/two"');
    expect(result.stdout).not.toContain('"externalId":"series/one"');
    expect(
      result.report.find((entry) => entry.entryId === "target").candidates[0].matchedIds,
    ).toEqual(["anilist", "mal"]);
  });

  it("defaults to non-MangaDex source priorities", () => {
    const result = run(["--apply"], "identity-default");
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.find((entry) => entry.entryId === "target")).toMatchObject({
      outcome: "matched",
      selectedId: "series/two",
    });
    expect(result.report.find((entry) => entry.event === "run")).toMatchObject({
      sourcePriority: [
        "Kodansha Comics",
        "VIZ Media",
        "Manga Up!",
        "Comikey",
        "Crunchyroll",
        "Square Enix Manga",
      ],
      excludedSources: ["MangaDex"],
    });
  });

  it("falls back globally when the preferred source has a contradictory ID", () => {
    const result = run(
      ["--apply", "--source-priority", "Kodansha Comics"],
      "identity-contradiction",
    );
    expect(result.status, result.stderr).toBe(0);
    const entry = result.report.find((item) => item.entryId === "target");
    expect(entry.selectedId).toBe("series/one");
    expect(entry.candidates.find((candidate) => candidate.id === "series/two").reasons).toContain(
      "contradictory mal ID",
    );
  });

  it.each([
    "identity-unproven",
    "identity-spoof",
    "identity-same-source",
    "identity-shared-conflict",
  ])("keeps %s unresolved instead of guessing", (scenario) => {
    const result = run(
      [
        "--apply",
        "--source-priority",
        scenario === "identity-shared-conflict" ? "none" : "Kodansha Comics",
      ],
      scenario,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.find((entry) => entry.entryId === "target")).toMatchObject({
      outcome: "ambiguous",
      selectedId: null,
    });
    expect(result.stdout).not.toContain("WRITE");
  });

  it("accepts renamed details when external IDs prove identity", () => {
    const result = run(["--apply", "--source-priority", "Kodansha Comics"], "identity-renamed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.find((entry) => entry.entryId === "target")).toMatchObject({
      outcome: "matched",
      selectedId: "series/two",
    });
  });

  it("compares MangaDex UUIDs rather than trusting a source name or matching title", () => {
    const result = run(["--apply"], "identity-mangadex");
    expect(result.status, result.stderr).toBe(0);
    const entry = result.report.find((item) => item.entryId === "target");
    expect(entry.selectedId).toBe("series/two");
    expect(entry.candidates.find((candidate) => candidate.id === "series/one").reasons).toContain(
      "contradictory mangadex ID",
    );
  });

  it("completes searches beyond page 20 but refuses a truncated result or repeated page", () => {
    const complete = run(["--apply"], "long-search");
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.report.find((entry) => entry.entryId === "target").selectedId).toBe("page-20");
    const progress = complete.report.findIndex(
      (entry) =>
        entry.event === "progress" && entry.message.includes('Search "A Story" page 21/21'),
    );
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(complete.report.findIndex((entry) => entry.entryId === "target"));
    expect(complete.stdout).toContain(
      '1/2 A Story [all non-MangaDex sources]: Search "A Story" page 21/21',
    );
    for (const scenario of ["long-search", "stuck-search"]) {
      const incomplete = run(["--apply", "--max-pages", "20"], scenario);
      expect(incomplete.status).toBe(1);
      expect(incomplete.report.find((entry) => entry.entryId === "target").outcome).toBe("errors");
      expect(incomplete.stdout).not.toContain("WRITE");
    }
  });

  it("retries transient catalog errors and retains a complete report", () => {
    const result = run(["--apply"], "retry");
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.filter((entry) => entry.event === "retry")).toHaveLength(2);
    expect(result.report.find((entry) => entry.entryId === "target").outcome).toBe("matched");
    expect(result.report.at(-1)).toMatchObject({
      event: "summary",
      completed: true,
      counts: { matched: 1, unmatched: 1, errors: 0 },
    });
    expect(JSON.stringify(result.report)).not.toContain("fake");
  }, 15_000);

  it.each(["cooldown", "cooldown-date"])(
    "stops the entire sweep for %s instead of querying the next entry early",
    (scenario) => {
      const result = run(["--apply"], scenario);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("SEARCH Nothing");
      expect(result.stdout).not.toContain("WRITE");
      expect(result.report.find((entry) => entry.entryId === "target").error).toContain(
        "Retry-After exceeds 120s",
      );
      expect(result.report.at(-1)).toMatchObject({ completed: false, counts: { errors: 1 } });
    },
  );

  it("reports partial failure once and keeps reasons even after progress replaces output", () => {
    const result = run(["--apply"], "malformed");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Completed with errors:");
    expect(result.stdout).not.toContain("Stopped:");
    expect(result.stdout).not.toContain("Applied:");
    expect(result.report.find((entry) => entry.entryId === "target").note).toContain(
      "unexpected response schema",
    );
    expect(result.report.at(-1)).toMatchObject({ completed: true, counts: { errors: 1 } });
  });

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
      ["--max-pages", "0"],
    ]) {
      const result = run(flags);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("REGISTRY_PAGE");
    }
  });
});
