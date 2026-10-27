/** @effect-diagnostics nodeBuiltinImport:off */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (scenario = "matched", flags: string[] = [], terminal = "tty") => {
  const directory = mkdtempSync(join(tmpdir(), "manganato-status-"));
  const report = join(directory, "report.jsonl");
  try {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
      import { mock } from 'bun:test';
      import * as browser from './src/browser-view';
      for (const key of Object.keys(process.env)) if (key.startsWith('MANIFOLD_')) delete process.env[key];
      process.env.TERM = ${JSON.stringify(terminal === "dumb" ? "dumb" : "xterm-256color")};
      Object.defineProperty(process.stdout, 'isTTY', {value:${terminal !== "pipe"}});
      Object.defineProperty(process.stderr, 'isTTY', {value:${terminal !== "pipe"}});
      if (${terminal === "off"}) process.env.MANIFOLD_PROGRAM_STATUS = '0';
      const scenario = ${JSON.stringify(scenario)};
      const title = id => ['Quasar Aurora','Nebula Comet','Starlight Cosmos'][id-1];
      const row = id => ({id:'entry-'+id,title:title(id),provider:'local',providerId:String(id),createdAt:1,updatedAt:1,
        state:{entryId:'entry-'+id,status:'reading',updatedAt:1},
        providers:[{provider:'mangadex',externalId:'identity-'+id,updatedAt:1}]});
      let current = 0;
      globalThis.fetch = async (input, init={}) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/registry')) return Response.json({entries:[row(1),row(2),row(3)]});
        if (url.hostname === 'api.mangadex.org') {
          current = Number(url.pathname.split('-').at(-1));
          return Response.json({data:{attributes:{title:{en:title(current)},altTitles:[]},relationships:[{type:'author',attributes:{name:'A Creator'}}]}});
        }
        if (url.pathname.endsWith('/providers')) {
          console.log('WRITE',init.body);
          return Response.json({...row(current),providers:[...row(current).providers,{provider:'manganato',externalId:'slug-'+current,updatedAt:1}]});
        }
        throw new Error('Unexpected network request: '+url);
      };
      class FixtureView {
        navigate = async () => {};
        close = () => {};
        evaluate = async script => {
          if (script.includes('document.readyState')) return 'https://www.manganato.gg|complete|'+(scenario === 'challenge' ? 'Just a moment...' : 'MangaNato');
          if (script.includes('/search/story/')) return {status:200,challenged:false,data:{title:'Search Results for manga',next:null,items:scenario === 'unmatched' ? [] : [{id:'slug-'+current,title:title(current)}]}};
          if (script.includes('/manga/')) {
            if (scenario === 'row-error') throw new Error('Fixture detail lookup failed');
            return {status:200,challenged:false,data:{id:'slug-'+current,title:title(current),aliases:[],authors:['A Creator']}};
          }
          throw new Error('Unexpected browser request');
        };
      }
      mock.module('./src/browser-view',()=>({...browser,openBunBrowserView:()=>new FixtureView()}));
      Bun.argv = ['bun','index.ts','registry','manganato','--api-origin','https://fixture.invalid','--api-token','fixture-token',
        '--chrome-cdp-url','ws://fixture/browser','--status','reading','--delay','0','--report',${JSON.stringify(report)},...${JSON.stringify(flags)}];
      await import('./index.ts');
    `,
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 15_000 },
    );
    return {
      ...result,
      journal: readFileSync(report, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      titles: [...result.stderr.matchAll(/\x1b\]2;([^\x1b]*)\x1b\\/gu)].map((match) => match[1]),
      reports: [...result.stderr.matchAll(/\x1b\]7501;([^\x1b]*)\x1b\\/gu)].map((match) =>
        Object.fromEntries(
          match[1]!.split(":").map((field) => {
            const separator = field.indexOf("=");
            const key = field.slice(0, separator);
            const value = field.slice(separator + 1);
            return [
              key,
              key === "title" || key === "msg"
                ? Buffer.from(value, "base64").toString("utf8")
                : value,
            ];
          }),
        ),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("registry manganato program status", () => {
  it.each([false, true])("reports selected-row progress with apply=%s", (apply) => {
    const result = run("matched", apply ? ["--apply"] : []);
    expect(result.status, JSON.stringify(result.journal)).toBe(0);
    expect(
      result.reports
        .filter((report) => report.progress !== undefined)
        .map((report) => report.progress),
    ).toEqual(["0", "33", "66", "100"]);
    expect(result.titles).toContain(
      apply
        ? "manifold: Checking and linking MangaNato 33%"
        : "manifold: Checking MangaNato links 33%",
    );
    expect(result.titles).toEqual(result.reports.map((report) => report.title));
    expect(result.reports.at(-2)?.title).toBe("manifold: Finalizing report");
    expect(result.reports.at(-2)?.progress).toBeUndefined();
    expect(result.reports.at(-1)).toMatchObject({
      state: "done",
      app: "manifold",
      title: "manifold: Done",
    });
    expect(result.reports.at(-1)?.msg).toContain("3 matched");
    expect(
      result.journal.filter((line) => line.event === "entry").map((line) => line.outcome),
    ).toEqual(["matched", "matched", "matched"]);
    expect(result.stdout.match(/WRITE /g) ?? []).toHaveLength(apply ? 3 : 0);
    expect(result.stdout).not.toContain("\x1b]7501;");
    if (apply) expect(result.stdout).toContain('"onConflict":"reject"');
  });

  it.each(["challenge", "row-error", "unmatched"])(
    "reports %s with its existing exit behavior",
    (scenario) => {
      const result = run(scenario);
      expect(result.status, result.stderr).toBe(scenario === "unmatched" ? 0 : 1);
      expect(result.reports.at(-1)?.state).toBe(scenario === "unmatched" ? "done" : "error");
      expect(result.reports.some((report) => report.state === "blocked")).toBe(false);
      expect(result.reports.at(-1)?.msg).toContain(
        scenario === "unmatched"
          ? "3 unmatched"
          : scenario === "challenge"
            ? "1 challenged"
            : "3 errors",
      );
    },
  );

  it.each([0, 1])("uses --limit %s as the denominator and skips empty browser work", (limit) => {
    const result = run("matched", ["--limit", String(limit)]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.reports
        .filter((report) => report.progress !== undefined)
        .map((report) => report.progress),
    ).toEqual(limit ? ["0", "100"] : []);
    expect(result.titles.includes("manifold: Connecting to Chrome")).toBe(limit > 0);
    expect(result.journal.filter((line) => line.event === "entry")).toHaveLength(limit);
  });

  it.each(["pipe", "off", "dumb"])("does not emit either OSC with terminal mode %s", (terminal) => {
    const result = run("matched", ["--limit", "1"], terminal);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("\x1b]7501;");
    expect(result.stdout).not.toContain("\x1b]2;");
    expect(result.stderr).not.toContain("\x1b]7501;");
    expect(result.stderr).not.toContain("\x1b]2;");
    expect(result.journal.find((line) => line.event === "entry")?.outcome).toBe("matched");
  });
});
