/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (flags: string[] = [], scenario = "normal") => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-xcomic-"));
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
      const group = {id:'group', title:'A Story', type_id:'manga', is_merged:scenario === 'merged', merged_to:null};
      const edition = (id) => ({id, name:'A Story', subName:id === 'small' ? 'Official' : null, translatedLanguage:'en', chaps_normal:id === 'empty' ? null : id === 'small' ? 900 : 5});
      const row = (id) => ({id, provider:'anilist', providerId:'123', title:'A Story', createdAt:1, updatedAt:1, state:{entryId:id, status:'reading', updatedAt:1}, providers:[{provider:'anilist', externalId:'123', updatedAt:1}, {provider:'mal', externalId:'456', updatedAt:1}, ...(scenario === 'audit' ? [{provider:'xcomic', externalId:'small', updatedAt:1}] : [])]});
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/registry')) return Response.json({entries:[row('target'), ...(scenario === 'owned' ? [{...row('owner'), providers:[{provider:'xcomic', externalId:'large', updatedAt:1}]}] : [])]});
        if (url.pathname.endsWith('/providers')) {
          const body = JSON.parse(init.body);
          console.info('WRITE', JSON.stringify(body));
          return Response.json({...row('target'), providers:[{...body, updatedAt:1}]});
        }
        if (url.hostname !== 'xcomic.me') throw new Error('Unexpected host '+url.hostname);
        const {query, variables} = JSON.parse(init.body);
        if (scenario === 'challenge' || scenario === 'rate-limit') return new Response('<title>Just a moment</title>', {status:scenario === 'challenge' ? 403 : 429});
        if (query.includes('get_title_browse_items') && query.includes('get_title_browse_pager')) return Response.json({data:null, errors:[{message:'multiple root fields not allowed'}]});
        if (query.includes('get_title_browse_pager')) return Response.json({data:{get_title_browse_pager:{next:scenario === 'paged' && variables.select.page === 1 ? 3 : scenario === 'stuck' ? 1 : 0}}});
        if (query.includes('get_title_browse_items')) {
          console.info('SEARCH', variables.select.page);
          return Response.json({data:{get_title_browse_items:scenario === 'empty' ? [] : [{data:{id:scenario === 'paged' && variables.select.page === 1 ? 'other-group' : 'group', name:'A Story', altNames:[]}, comicNodes:[{data:{id:'small', name:'A Story'}}]}], get_title_browse_pager:{next:scenario === 'paged' && variables.select.page === 1 ? 3 : scenario === 'stuck' ? 1 : 0}}, ...(scenario === 'graphql-errors' ? {errors:[{message:'partial'}]} : {})});
        }
        if (query.includes('get_title_titleNode')) return Response.json({data:{get_title_titleNode:{data:{...group,id:variables.id}, comicNodes:variables.id === 'other-group' ? [] : ['small','large','pilot','foreign','empty'].map(id => ({data:edition(id)}))}}});
        if (query.includes('get_comicNode')) {
          const id = variables.id;
          return Response.json({data:{get_comicNode:{data:{...edition(id), translatedLanguage:id === 'foreign' || (scenario === 'language' && id === 'large') ? 'ja' : 'en', type:scenario === 'novel' && id === 'large' ? 'novel' : null, altNames:[], title_id:'group', title_titleNode:{data:group}, trackingSites:scenario === 'title-only' ? null : {anilist:id === 'pilot' ? '999' : scenario === 'spoof' && id === 'large' ? 'https://anilist.co.evil.test/manga/123' : 'https://anilist.co/manga/123', myanimelist:id === 'pilot' || (scenario === 'contradiction' && id === 'large') ? '777' : '456'}}}}});
        }
        if (query.includes('get_comic_chapterList_uniqList')) {
          const {comic_id:id, page} = variables.select;
          if (id === 'empty') return Response.json({data:{get_comic_chapterList_uniqList:{paging:{pages:0}, items:[]}}});
          if (scenario === 'inventory-error' && id === 'large') return new Response('down', {status:503});
          const numbers = id === 'small' || (scenario === 'tie' && id === 'large') ? [1,1,1,1,2,2,2,2,99] : page === 1 ? [1,2,3] : [4,5];
          return Response.json({data:{get_comic_chapterList_uniqList:{paging:{pages:id === 'large' && scenario !== 'tie' ? 2 : 1}, items:numbers.map((chaNum,i) => ({data:{id:scenario === 'duplicate-page' && id === 'large' ? 'same' : id+'-'+page+'-'+i, dbStatus:chaNum === 99 ? 'deleted' : 'normal', chaNum:scenario === 'unknown' && id === 'large' && i === 0 ? null : chaNum}}))}}});
        }
        throw new Error('Unexpected query '+query);
      };
      try { await Effect.runPromise(Command.runWith(makeRootCommand('test'), {version:'test'})(${JSON.stringify(["registry", "xcomic", "--report", report, "--delay", "0", "--status", "reading", ...flags])}).pipe(Effect.provide(BunServices.layer))); }
      catch (error) {console.error(error); process.exitCode=1;}
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

describe("registry xcomic", () => {
  it("chooses complete distinct normal chapter coverage, not advertised counts, badges or the pilot's larger count", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const entry = result.report.find((item) => item.entryId === "target");
    expect(entry).toMatchObject({ outcome: "matched", selectedId: "large" });
    expect(entry.candidates.find((candidate) => candidate.id === "large").coverage).toEqual({
      unit: "chapters",
      count: 5,
      numbers: [1, 2, 3, 4, 5],
    });
    expect(entry.candidates.find((candidate) => candidate.id === "empty")).toMatchObject({
      advertisedChapters: null,
      coverage: { unit: "chapters", count: 0, numbers: [] },
    });
    expect(entry.candidates.find((candidate) => candidate.id === "pilot").reasons).toContain(
      "contradictory anilist ID",
    );
    expect(result.stdout).not.toContain("WRITE");
  });

  it("applies the opaque edition ID and origin with conflict rejection, never the title-group ID", () => {
    const result = run(["--apply"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'WRITE {"provider":"xcomic","externalId":"large","title":"A Story","sourceName":"Origin unknown","onConflict":"reject"}',
    );
  });

  it.each(["contradiction", "spoof", "language", "novel"])(
    "rejects a larger %s edition",
    (scenario) => {
      const result = run(["--apply"], scenario);
      expect(result.status, result.stderr).toBe(0);
      expect(result.report.find((item) => item.entryId === "target")).toMatchObject({
        outcome: "matched",
        selectedId: "small",
      });
    },
  );

  it.each(["title-only", "merged", "tie", "unknown"])(
    "leaves %s for review without guessing",
    (scenario) => {
      const result = run(["--apply"], scenario);
      expect(result.status, result.stderr).toBe(0);
      expect(result.report.find((item) => item.entryId === "target")).toMatchObject({
        outcome: "ambiguous",
        selectedId: null,
      });
      expect(result.stdout).not.toContain("WRITE");
    },
  );

  it.each([
    "inventory-error",
    "duplicate-page",
    "stuck",
    "graphql-errors",
    "challenge",
    "rate-limit",
  ])("fails closed on %s instead of selecting an easier competitor", (scenario) => {
    const result = run(["--apply"], scenario);
    expect(result.status).toBe(1);
    expect(result.report.find((item) => item.entryId === "target").outcome).toBe(
      ["challenge", "rate-limit"].includes(scenario) ? "blocked" : "errors",
    );
    expect(result.stdout).not.toContain("WRITE");
    expect(JSON.stringify(result.report)).not.toContain("fake");
  });

  it("follows the returned search pager and refuses truncation", () => {
    const complete = run([], "paged");
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stdout).toContain("SEARCH 3");
    expect(complete.report.find((item) => item.entryId === "target").selectedId).toBe("large");
    const incomplete = run(["--apply", "--max-pages", "1"], "paged");
    expect(incomplete.status).toBe(1);
    expect(incomplete.stdout).not.toContain("WRITE");
  });

  it("audits existing links without writing and reports gained chapter positions", () => {
    const result = run(["--audit-existing"], "audit");
    expect(result.status, result.stderr).toBe(0);
    expect(result.report.find((item) => item.entryId === "target")).toMatchObject({
      currentId: "small",
      selectedId: "large",
      coverageDifference: { gained: [3, 4, 5], lost: [] },
    });
    expect(result.stdout).not.toContain("WRITE");
    expect(run(["--apply", "--audit-existing"]).status).toBe(1);
    expect(run(["--apply"], "audit").report.filter((item) => item.event === "entry")).toEqual([]);
  });

  it("rejects owned editions, reports real misses and avoids catalog work for limit zero", () => {
    const conflict = run(["--apply"], "owned");
    expect(conflict.status).toBe(1);
    expect(conflict.report.find((item) => item.entryId === "target").outcome).toBe("conflicts");
    expect(conflict.stdout).not.toContain("WRITE");
    expect(run([], "empty").report.find((item) => item.entryId === "target").outcome).toBe(
      "unmatched",
    );
    expect(run(["--limit", "0"], "challenge").status).toBe(0);
  });
});
