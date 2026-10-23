/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (flags: string[] = [], scenario = "normal") => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-pas5-import-"));
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
      import { buildPas5Zip } from './src/pas5';
      import { readFileSync, writeFileSync } from 'node:fs';
      for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
      process.env.MANIFOLD_TOKEN = 'fake-private-token';
      const scenario = ${JSON.stringify(scenario)};
      const input = ${JSON.stringify(join(directory, "input.pas5"))};
      const source = (id, sourceId, mangaId) => ({id, sourceId, mangaId, schemaVersion:1, mangaInfo:{id, type:'__MANGA_INFO_V5'}});
      const sources = {
        tracker:source('tracker','MANIFOLD','target'),
        md:source('md','MangaDex','md-uuid'),
        kagane:source('kagane','Kagane','kagane-uuid'),
        nato:source('nato','MangaNato','a-story-slug'),
        xcomic:source('xcomic','XCOMIC','edition-id'),
        retired:source('retired','Comix','retired-id'),
        // A malformed unreferenced cache record must not prevent importing the library.
        cached:null,
      };
      const info = {primaryTitle:'A Story', secondaryTitles:['別名', 'Alternate Title'], author:'Author Name', artist:['Artist A','Artist B'], shareUrl:'https://example.test/story', additionalInfo:{}};
      const infos = Object.fromEntries(Object.keys(sources).map(id => [id,{...info}]));
      infos.tracker = {...info, additionalInfo:{'Canonical ID':'target', 'Canonical provider':'registry', 'AniList ID':'123'}};
      const library = {id:'library', attachedSources:Object.keys(sources).filter(id => id !== 'cached').map(id => ({id,type:'__SOURCE_MANGA_V5'})), dateBookmarked:17,lastRead:31,libraryTabs:[{id:'tab', name:'Paused',sortOrder:0}]};
      const libraries = {library};
      const row = (id, anilist) => ({id, provider:'anilist', providerId:anilist, title:'Registry title', createdAt:1,updatedAt:2, providers:[{provider:'anilist',externalId:anilist,updatedAt:1}], state:{entryId:id,status:'on_hold',score:8,updatedAt:2}});
      const rows = [row('target','123')];
      if (scenario === 'native-anchor' || scenario === 'unresolved') {
        library.attachedSources = library.attachedSources.filter(ref => ref.id !== 'tracker');
        if (scenario === 'native-anchor') rows[0].providers.push({provider:'mangadex',externalId:'md-uuid',updatedAt:1});
      }
      if (scenario === 'same-title') {
        sources.tracker.mangaId = 'missing-target';
        infos.tracker.additionalInfo = {};
        rows[0].title = 'A Story';
      }
      if (scenario === 'stale') sources.tracker.mangaId = 'old-target';
      if (scenario === 'metadata-conflict') infos.tracker.additionalInfo['AniList ID'] = '456';
      if (scenario === 'foreign-owner' || scenario === 'tombstoned-owner') {
        const owner = row('owner','456');
        owner.providers.push({provider:'xcomic',externalId:'edition-id',updatedAt:1});
        if (scenario === 'tombstoned-owner') owner.tombstoned = true;
        rows.push(owner);
      }
      if (scenario === 'target-tombstoned') rows[0].tombstoned = true;
      if (scenario === 'existing-edition') rows[0].providers.push({provider:'kagane',externalId:'different-uuid',updatedAt:1});
      if (scenario === 'two-editions') {
        sources.extra = source('extra','XCOMIC','other-edition');
        infos.extra = info;
        library.attachedSources.push({id:'extra',type:'__SOURCE_MANGA_V5'});
      }
      if (scenario === 'cross-owner' || scenario === 'cross-edition') {
        sources.other = source('other','MANIFOLD',scenario === 'cross-owner' ? 'other-target' : 'target');
        infos.other = {...info,additionalInfo:{}};
        sources.otherEdition = source('otherEdition','XCOMIC',scenario === 'cross-owner' ? 'edition-id' : 'other-edition');
        infos.otherEdition = info;
        libraries.other = {...library,id:'other',attachedSources:['other','otherEdition'].map(id => ({id,type:'__SOURCE_MANGA_V5'}))};
        if (scenario === 'cross-owner') rows.push(row('other-target','456'));
      }
      if (scenario === 'duplicate-library') libraries.duplicate = {...library,id:'duplicate'};
      if (scenario === 'broken-reference') delete sources.kagane;
      if (scenario === 'missing-info') delete infos.xcomic;
      const archive = {__LIBRARY_MANGA_V5:libraries,__SOURCE_MANGA_V5:sources,__MANGA_INFO_V5:infos};
      if (scenario === 'malformed-archive') delete archive.__SOURCE_MANGA_V5;
      const original = buildPas5Zip(Object.fromEntries(Object.entries(archive).map(([name,value]) => [name,JSON.stringify(value)])));
      writeFileSync(input, original);
      const writes = [];
      globalThis.fetch = async (request, init = {}) => {
        const url = new URL(String(request));
        if (init.method === 'GET' && url.pathname.endsWith('/registry')) return Response.json({entries:rows});
        if (init.method === 'POST' && url.pathname.endsWith('/target/providers')) {
          const body = JSON.parse(init.body);
          if (body.onConflict !== 'reject') throw new Error('Unsafe conflict policy');
          if (scenario === 'race' && body.provider === 'kagane') return Response.json({error:'Provider link conflict: raced'}, {status:409});
          if (rows[0].providers.some(link => link.provider === body.provider)) throw new Error('Duplicate or replacing write');
          rows[0].providers.push({...body,updatedAt:3});
          writes.push(body);
          return Response.json(rows[0]);
        }
        throw new Error('Unexpected request '+init.method+' '+url);
      };
      const invoke = async (report) => Effect.runPromise(Command.runWith(makeRootCommand('test'), {version:'test'})(['registry','import-pas5','--input',input,'--report',report,...${JSON.stringify(flags)}]).pipe(Effect.provide(BunServices.layer)));
      try {
        await invoke(${JSON.stringify(report)});
        if (scenario === 'repeat') await invoke(${JSON.stringify(join(directory, "repeat.jsonl"))});
      } catch(error) {console.error(error);process.exitCode=1;}
      if (!readFileSync(input).equals(original)) throw new Error('Original archive changed');
      console.info('RESULT',JSON.stringify({writes,rows}));
    `,
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 20_000 },
    );
    const readReport = (path: string) =>
      existsSync(path)
        ? readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    return {
      ...result,
      report: readReport(report),
      repeat: readReport(join(directory, "repeat.jsonl")),
      permissions: existsSync(report) ? statSync(report).mode & 0o777 : undefined,
      registry: JSON.parse(
        result.stdout
          .split("\n")
          .find((line) => line.startsWith("RESULT "))!
          .slice(7),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("registry import-pas5", () => {
  it("reports only attached identities and useful strings without provider requests or mutations", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.permissions).toBe(0o600);
    expect(result.registry.writes).toEqual([]);
    expect(result.report.find((item) => item.event === "run")).toMatchObject({
      apply: false,
      evidence: "paperback-attachment",
      independentlyVerified: false,
    });
    expect(result.report.find((item) => item.event === "entry")).toMatchObject({
      entryId: "target",
      outcome: "ready",
      titles: ["A Story", "別名", "Alternate Title"],
      authors: ["Author Name"],
      artists: ["Artist A", "Artist B"],
      shareUrls: ["https://example.test/story"],
      ignoredSourceIds: ["Comix"],
      missingLinks: [
        { provider: "mangadex", externalId: "md-uuid" },
        { provider: "kagane", externalId: "kagane-uuid" },
        { provider: "manganato", externalId: "a-story-slug" },
        { provider: "xcomic", externalId: "edition-id" },
      ],
    });
    expect(JSON.stringify(result.report)).not.toContain("fake-private-token");
  });

  it("applies missing links, preserves registry state and makes a repeated import a no-op", () => {
    const result = run(["--apply"], "repeat");
    expect(result.status, result.stderr).toBe(0);
    expect(result.registry.writes).toHaveLength(4);
    expect(result.registry.rows[0]).toMatchObject({
      title: "Registry title",
      updatedAt: 2,
      state: { status: "on_hold", score: 8, updatedAt: 2 },
    });
    expect(result.repeat.find((item) => item.event === "entry")).toMatchObject({
      outcome: "unchanged",
      missingLinks: [],
    });
    expect(result.repeat.find((item) => item.event === "summary").linksWritten).toBe(0);
  });

  it("can resolve an untracked library through an existing exact native link", () => {
    const result = run(["--apply"], "native-anchor");
    expect(result.status, result.stderr).toBe(0);
    expect(result.registry.writes.map((write) => write.provider)).toEqual([
      "kagane",
      "manganato",
      "xcomic",
    ]);
  });

  it.each([
    "stale",
    "same-title",
    "metadata-conflict",
    "foreign-owner",
    "tombstoned-owner",
    "target-tombstoned",
    "existing-edition",
    "two-editions",
    "cross-owner",
    "cross-edition",
  ])("rejects %s without writing any part of the conflicting library", (scenario) => {
    const result = run(["--apply"], scenario);
    expect(result.status, result.stderr).toBe(1);
    expect(result.registry.writes).toEqual([]);
    expect(
      result.report
        .filter((item) => item.event === "entry")
        .every((item) => item.outcome === "conflict"),
    ).toBe(true);
  });

  it("leaves title-only libraries unresolved instead of minting entries", () => {
    const result = run(["--apply"], "unresolved");
    expect(result.status, result.stderr).toBe(0);
    expect(result.registry.writes).toEqual([]);
    expect(result.report.find((item) => item.event === "entry").outcome).toBe("unresolved");
  });

  it("deduplicates writes when two library entries reference the same bindings", () => {
    const result = run(["--apply"], "duplicate-library");
    expect(result.status, result.stderr).toBe(0);
    expect(result.registry.writes).toHaveLength(4);
  });

  it.each(["broken-reference", "missing-info", "malformed-archive"])(
    "fails closed on %s",
    (scenario) => {
      const result = run(["--apply"], scenario);
      expect(result.status).toBe(1);
      expect(result.registry.writes).toEqual([]);
    },
  );

  it("reports partial success if the server rejects a later binding race", () => {
    const result = run(["--apply"], "race");
    expect(result.status).toBe(1);
    expect(result.registry.writes.map((write) => write.provider)).toEqual(["mangadex"]);
    expect(result.report.find((item) => item.event === "entry")).toMatchObject({
      outcome: "error",
      error: "Provider link conflict: raced",
    });
    expect(result.report.find((item) => item.event === "summary")).toMatchObject({
      linksWritten: 1,
      counts: { error: 1 },
    });
  });
});
