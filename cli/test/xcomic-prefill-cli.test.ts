/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (
  flags: string[] = [],
  scenario = "normal",
  options: { checkpoint?: string; resume?: readonly unknown[] } = {},
) => {
  const { checkpoint } = options;
  const directory = mkdtempSync(join(tmpdir(), "manifold-xcomic-"));
  const report = join(directory, "report.jsonl");
  const resume = join(directory, "resume.jsonl");
  try {
    if (options.resume)
      writeFileSync(resume, options.resume.map((line) => JSON.stringify(line)).join("\n") + "\n");
    if (checkpoint)
      writeFileSync(
        resume,
        [
          { event: "run", apply: false, language: "en", origin: "https://xcomic.me" },
          { event: "entry", entryId: "target", title: "A Story", outcome: checkpoint },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
      import { BunServices } from '@effect/platform-bun';
      import { Effect } from 'effect';
      import { Command } from 'effect/cli';
      import { makeRootCommand } from './src/cli';
      import { readFileSync } from 'node:fs';
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
          console.info('SELECTION_BEFORE_WRITE', readFileSync(${JSON.stringify(report)}, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line)).some(line => line.event === 'selection' && line.key === 'target' && line.selectedId === body.externalId));
          console.info('WRITE', JSON.stringify(body));
          return Response.json({...row('target'), providers:[{...body, updatedAt:1}]});
        }
        if (url.hostname !== 'xcomic.me') throw new Error('Unexpected host '+url.hostname);
        const {query, variables} = JSON.parse(init.body);
        console.info('READ', query.includes('get_comic_chapterList_uniqList') ? 'chapters '+variables.select.comic_id+' '+variables.select.page : query.includes('get_comicNode') ? 'detail '+variables.id : query.includes('get_title_titleNode') ? 'group '+variables.id : query.includes('get_title_browse_pager') ? 'pager '+variables.select.page : 'search '+variables.select.page);
        if (scenario === 'challenge' || scenario === 'rate-limit') return new Response('<title>Just a moment</title>', {status:scenario === 'challenge' ? 403 : 429});
        if (query.includes('get_title_browse_items') && query.includes('get_title_browse_pager')) return Response.json({data:null, errors:[{message:'multiple root fields not allowed'}]});
        if (scenario === 'interrupt-pager' && query.includes('get_title_browse_pager')) return new Response('interrupted pager', {status:400});
        if (query.includes('get_title_browse_pager')) return Response.json({data:{get_title_browse_pager:{next:scenario === 'paged' && variables.select.page === 1 ? 3 : scenario === 'stuck' ? 1 : 0}}});
        if (query.includes('get_title_browse_items')) {
          console.info('SEARCH', variables.select.page);
          return Response.json({data:{get_title_browse_items:scenario === 'empty' || scenario === 'omit' ? [] : [{data:{id:scenario === 'paged' && variables.select.page === 1 ? 'other-group' : 'group', name:'A Story', altNames:[]}, comicNodes:[{data:{id:'small', name:'A Story'}}]}], get_title_browse_pager:{next:scenario === 'paged' && variables.select.page === 1 ? 3 : scenario === 'stuck' ? 1 : 0}}, ...(scenario === 'graphql-errors' ? {errors:[{message:'partial'}]} : {})});
        }
        if (query.includes('get_title_titleNode')) return Response.json({data:{get_title_titleNode:{data:{...group,id:variables.id}, comicNodes:variables.id === 'other-group' ? [] : ['small','large','pilot','foreign','empty'].map(id => ({data:edition(id)}))}}});
        if (query.includes('get_comicNode')) {
          const id = variables.id;
          if (scenario === 'interrupt-detail' && id === 'small') return new Response('interrupted detail', {status:400});
          return Response.json({data:{get_comicNode:{data:{...edition(id), translatedLanguage:id === 'foreign' || (scenario === 'language' && id === 'large') ? 'ja' : 'en', type:scenario === 'novel' && id === 'large' ? 'novel' : null, altNames:[], title_id:'group', title_titleNode:{data:group}, trackingSites:scenario === 'title-only' ? null : {anilist:id === 'pilot' ? '999' : scenario === 'spoof' && id === 'large' ? 'https://anilist.co.evil.test/manga/123' : 'https://anilist.co/manga/123', myanimelist:id === 'pilot' || (scenario === 'contradiction' && id === 'large') ? '777' : '456'}}}}});
        }
        if (query.includes('get_comic_chapterList_uniqList')) {
          const {comic_id:id, page} = variables.select;
          if (id === 'empty') return Response.json({data:{get_comic_chapterList_uniqList:{paging:{pages:0}, items:[]}}});
          if (scenario === 'interrupt-inventory' && id === 'small') return new Response('interrupted inventory', {status:400});
          if (scenario === 'inventory-incomplete' && id === 'large' && page === 2) return Response.json({data:{get_comic_chapterList_uniqList:{paging:{pages:2}, items:[]}}});
          if (scenario === 'inventory-error' && id === 'large') return new Response('down', {status:503});
          const numbers = id === 'small' || (scenario === 'tie' && id === 'large') ? [1,1,1,1,2,2,2,2,99] : scenario === 'crossing-equal' ? [1,8] : scenario === 'crossing-larger' ? (page === 1 ? [1,3,4] : [5,8]) : page === 1 ? [1,2,3] : [4,5];
          return Response.json({data:{get_comic_chapterList_uniqList:{paging:{pages:id === 'large' && scenario !== 'tie' && scenario !== 'crossing-equal' ? 2 : 1}, items:numbers.map((chaNum,i) => ({data:{id:scenario === 'duplicate-page' && id === 'large' ? 'same' : id+'-'+page+'-'+i, dbStatus:chaNum === 99 ? 'deleted' : 'normal', chaNum:scenario === 'unknown' && id === 'large' && i === 0 ? null : chaNum}}))}}});
        }
        throw new Error('Unexpected query '+query);
      };
      try { await Effect.runPromise(Command.runWith(makeRootCommand('test'), {version:'test'})(${JSON.stringify(["registry", "xcomic", "--report", report, ...(checkpoint || options.resume ? ["--resume", resume] : []), "--delay", "0", "--status", "reading", ...flags])}).pipe(Effect.provide(BunServices.layer))); }
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
  it("recovers an incomplete final chapter page without refetching its valid prefix", () => {
    const failed = run(["--apply"], "inventory-incomplete");
    expect(failed.status).toBe(1);
    expect(failed.report.find((line) => line.event === "entry")).toMatchObject({
      outcome: "errors",
      selectedId: null,
    });
    expect(failed.stdout).not.toContain("WRITE");
    expect(
      failed.report
        .filter((line) => line.kind === "read")
        .some((line) => {
          const inventory = JSON.parse(line.data).data?.get_comic_chapterList_uniqList;
          return inventory?.paging.pages === 2 && inventory.items.length === 0;
        }),
    ).toBe(false);
    const recovered = run(["--apply"], "normal", { resume: failed.report });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("READ chapters large 2");
    expect(recovered.stdout).not.toContain("READ chapters large 1");
    expect(recovered.stdout).not.toContain("READ chapters small");
    expect(recovered.stdout).not.toContain("READ search");
    expect(recovered.stdout).toContain("SELECTION_BEFORE_WRITE true");
    expect(recovered.stdout).toContain('"externalId":"large"');
    for (const line of failed.report.filter((line) => line.kind === "read")) {
      expect(
        recovered.report.find((cached) => cached.kind === "read" && cached.key === line.key),
      ).toEqual(line);
    }
  });

  it("refetches a schema-valid but incomplete cached final chapter page", () => {
    const preview = run();
    expect(preview.status, preview.stderr).toBe(0);
    const resume = preview.report.map((line) => {
      if (line.kind !== "read") return line;
      const body = JSON.parse(line.data);
      const inventory = body.data?.get_comic_chapterList_uniqList;
      if (!inventory?.items.some((item) => item.data.id.startsWith("large-2-"))) return line;
      inventory.items = [];
      return { ...line, data: JSON.stringify(body) };
    });
    expect(resume).not.toEqual(preview.report);
    const result = run(["--apply"], "normal", { resume });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^READ .+$/gm)).toEqual(["READ chapters large 2"]);
    expect(result.stdout).toContain("SELECTION_BEFORE_WRITE true");
    expect(result.report.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "large",
    });
  });

  it.each(["pager", "detail", "inventory"])(
    "retains discovered competitors across a %s interruption even when fresh search omits the group",
    (stage) => {
      const failed = run(["--apply"], `interrupt-${stage}`);
      expect(failed.status).toBe(1);
      expect(failed.stdout).not.toContain("WRITE");
      const ids = failed.report
        .filter((line) => line.kind === "candidates")
        .flatMap((line) => line.data);
      expect(ids).toContain("small");
      if (stage !== "pager") {
        expect(ids).toContain("large");
        expect(failed.stdout).not.toContain("READ detail large");
      }
      for (const cache of ["removed", "expired"]) {
        const resume = failed.report.flatMap((line) =>
          line.kind !== "read"
            ? [line]
            : cache === "removed"
              ? []
              : [{ ...line, savedAt: Date.now() - 86_400_001 }],
        );
        const recovered = run(["--apply"], "omit", { resume });
        expect(recovered.status, recovered.stderr).toBe(0);
        expect(recovered.stdout).toContain("READ search 1");
        expect(recovered.stdout).toContain("READ detail small");
        expect(recovered.stdout).toContain("READ detail large");
        expect(recovered.stdout).toContain("READ chapters large 2");
        expect(recovered.report.find((line) => line.event === "entry")).toMatchObject({
          outcome: "matched",
          selectedId: "large",
        });
        expect(recovered.stdout).toContain("SELECTION_BEFORE_WRITE true");
      }
    },
  );

  it("resumes interrupted chapter pages across reports while honoring a lower budget and original cache timestamps", () => {
    const interrupted = run(["--max-pages", "1"]);
    expect(interrupted.status, interrupted.stderr).toBe(0);
    expect(interrupted.report.find((line) => line.entryId === "target")).toMatchObject({
      outcome: "deferred",
      deferredReason: "page_budget",
    });
    expect(interrupted.stdout).not.toContain("WRITE");
    const complete = run(["--max-pages", "2"], "normal", { resume: interrupted.report });
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stdout).not.toContain("READ chapters large 1");
    expect(complete.stdout).toContain("READ chapters large 2");
    expect(complete.stdout).not.toContain("READ search");
    expect(complete.report.find((line) => line.event === "entry").selectedId).toBe("large");
    const lower = run(["--apply", "--max-pages", "1"], "normal", { resume: complete.report });
    expect(lower.status, lower.stderr).toBe(0);
    expect(lower.report.find((line) => line.event === "entry").outcome).toBe("deferred");
    expect(lower.stdout).not.toMatch(/^READ /m);
    expect(lower.stdout).not.toContain("WRITE");
    const applied = run(["--apply", "--max-pages", "2"], "normal", { resume: lower.report });
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).not.toMatch(/^READ /m);
    expect(applied.stdout).toContain("SELECTION_BEFORE_WRITE true");
    for (const line of complete.report.filter((line) => line.kind === "read")) {
      expect(
        applied.report.find((cached) => cached.kind === "read" && cached.key === line.key),
      ).toEqual(line);
    }
  });

  it("refetches invalid, expired and future cache records before applying", () => {
    const preview = run();
    for (const invalid of ["schema", "expired", "future"]) {
      const resume = preview.report.map((line) =>
        line.kind !== "read"
          ? line
          : {
              ...line,
              ...(invalid === "schema"
                ? { data: '{"data":null}' }
                : { savedAt: Date.now() + (invalid === "future" ? 86_400_000 : -86_400_001) }),
            },
      );
      const result = run(["--apply"], "normal", { resume });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("READ search 1");
      expect(result.stdout).toContain("READ detail large");
      expect(result.stdout).toContain("READ chapters large 2");
      expect(result.stdout).toContain("SELECTION_BEFORE_WRITE true");
    }
  });

  it.each(["equal", "larger"])(
    "never writes a %s crossing inventory that loses known chapter positions",
    (size) => {
      const result = run(["--apply"], `crossing-${size}`);
      expect(result.status, result.stderr).toBe(0);
      const entry = result.report.find((line) => line.event === "entry");
      expect(entry).toMatchObject({ outcome: "ambiguous", selectedId: null });
      expect(entry.selection.comparisons).toContainEqual({
        from: "small",
        to: "large",
        difference: { gained: size === "equal" ? [8] : [3, 4, 5, 8], lost: [2] },
      });
      expect(result.stdout).not.toContain("WRITE");
    },
  );

  it("revalidates known editions even when fresh search omits their title group", () => {
    const prior = run([], "crossing-equal");
    const resume = prior.report.filter((line) => line.kind !== "read");
    const result = run(["--apply"], "omit", { resume });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SEARCH 1");
    expect(result.stdout).toContain("READ detail small");
    expect(result.stdout).toContain("READ detail large");
    expect(result.stdout).toContain("READ chapters large 2");
    expect(result.report.find((line) => line.event === "entry")).toMatchObject({
      outcome: "matched",
      selectedId: "large",
    });
    expect(result.stdout).toContain("SELECTION_BEFORE_WRITE true");
  });

  it("resumes legacy checks but retries dry-run matches when applying", () => {
    const resumed = run([], "normal", { checkpoint: "matched" });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).not.toContain("SEARCH");
    const apply = run(["--apply"], "normal", { checkpoint: "matched" });
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.stdout).toContain("WRITE");
  });

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
    expect(result.stdout).toContain("SELECTION_BEFORE_WRITE true");
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
    expect(incomplete.status).toBe(0);
    expect(incomplete.report.find((item) => item.entryId === "target").outcome).toBe("deferred");
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
