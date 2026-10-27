/** @effect-diagnostics nodeBuiltinImport:off */
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@manifold/json";
import type { RegistryRow } from "../src/commands/toolbox";
import { openRegistryReport } from "../src/registry-report";

const directories: string[] = [];
const paths = () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-resume-"));
  directories.push(directory);
  return ["first", "second", "third"].map((name) => join(directory, `${name}.jsonl`));
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const settings = { apiOrigin: "https://registry.test", language: "en" };
const row = (id = "a"): RegistryRow => ({
  id,
  provider: "anilist",
  providerId: id,
  title: `Title ${id}`,
  providers: [{ provider: "anilist", externalId: id, updatedAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  state: { entryId: id, status: "reading", updatedAt: 1 },
});

describe("registry report resume", () => {
  it("reopens ambiguities for inference opt-in and preserves accepted decisions across two resumes", () => {
    const [first, second, third] = paths();
    const retryWhen = { selectionPolicy: 11, acceptRecommendations: false };
    const decision = {
      selectedId: "newer",
      selection: {
        basis: "active-listing",
        lostPositions: [{ candidateId: "older", numbers: [0, 1.5] }],
      },
      acceptedRecommendation: true,
      recommendation: { candidateId: "newer", requiresOptIn: true, acceptEligible: true },
    };
    const report = openRegistryReport("manganato", false, settings, first);
    report.entry(row(), { outcome: "ambiguous", selectionPolicy: 11, retryWhen });
    report.entry(row("legacy"), { outcome: "ambiguous", selectionPolicy: 11 });
    report.entry(row("accepted"), { outcome: "matched", ...decision });
    report.close();
    const resumed = openRegistryReport("manganato", false, settings, second, first);
    expect(resumed.skip(row(), retryWhen)).toBe(true);
    expect(resumed.skip(row(), { ...retryWhen, acceptRecommendations: true })).toBe(false);
    expect(resumed.skip(row("legacy"), { ...retryWhen, acceptRecommendations: true })).toBe(false);
    resumed.entry(row(), {
      outcome: "ambiguous",
      selectionPolicy: 11,
      retryWhen: { ...retryWhen, acceptRecommendations: true },
    });
    resumed.close();
    const again = openRegistryReport("manganato", false, settings, third, second);
    try {
      expect(again.skip(row(), { ...retryWhen, acceptRecommendations: true })).toBe(true);
      expect(again.skip(row(), retryWhen)).toBe(true);
      expect(again.checkpoint(row("accepted"))).toMatchObject(decision);
      expect(again.skip(row("accepted"), retryWhen)).toBe(true);
      expect(again.candidateIds(row("accepted"))).toEqual([]);
    } finally {
      again.close();
    }
  });

  it("reopens old ambiguities for a new selection policy and carries competitors through resume chains", () => {
    const [first, second, third] = paths();
    const report = openRegistryReport("manganato", false, settings, first);
    const candidates = [{ id: "romanized" }, { id: "translated" }];
    const chapterReference = {
      provider: "anilist",
      providerId: "123",
      chapters: 20,
      status: "FINISHED",
    };
    const provenance = {
      discovery: {
        limitedCoverage: true,
        usefulQuery: "romanized",
        stopReason: "useful_complete_query",
        attempts: [{ query: "romanized", status: "complete", candidateIds: ["romanized"] }],
        omittedQueries: ["translated"],
      },
      titles: ["Title a"],
      authors: ["Creator"],
      queries: ["romanized"],
      cappedQueries: [],
      selectedId: null,
      candidateIds: ["romanized", "translated"],
      note: "Tied coverage",
    };
    report.entry(row(), { outcome: "ambiguous", candidates, chapterReference, ...provenance });
    report.entry(row("b"), { outcome: "ambiguous", selectionPolicy: 1 });
    report.close();
    const resumed = openRegistryReport("manganato", false, settings, second, first);
    expect(resumed.skip(row(), { selectionPolicy: 1 })).toBe(false);
    expect(resumed.skip(row("b"), { selectionPolicy: 1 })).toBe(true);
    resumed.close();
    const again = openRegistryReport("manganato", false, settings, third, second);
    try {
      expect(again.skip(row(), { selectionPolicy: 1 })).toBe(false);
      expect(again.checkpoint(row())?.candidates).toEqual(candidates);
      expect(again.checkpoint(row())?.chapterReference).toEqual(chapterReference);
      expect(again.checkpoint(row())).toMatchObject(provenance);
      expect(again.checkpoint({ ...row(), title: "Changed" })).toBeUndefined();
      expect(again.skip(row("b"), { selectionPolicy: 1 })).toBe(true);
      expect(again.skip(row("b"), { selectionPolicy: 2 })).toBe(false);
    } finally {
      again.close();
    }
  });

  it("carries typed deferrals and catalog timestamps through chains; retries when budget, policy or identity changes", () => {
    const [first, second, third] = paths();
    const retryWhen = { maxPages: 5, searchPolicy: 1 };
    const report = openRegistryReport("manganato", false, settings, first);
    report.entry(row(), {
      outcome: "deferred",
      deferredReason: "page_budget",
      retryWhen,
      searchPolicy: 1,
    });
    report.entry(row("b"), { outcome: "unmatched", searchPolicy: 1 });
    report.entry(row("c"), { outcome: "errors", note: "page limit or repeated pagination" });
    report.entry(row("d"), { outcome: "ambiguous", searchPolicy: 1 });
    const catalog = {
      event: "catalog",
      kind: "search",
      key: "pseudo",
      origin: "https://www.manganato.gg",
      savedAt: 123,
      data: [],
    };
    report.record(catalog);
    report.close();
    const resumed = openRegistryReport("manganato", false, settings, second, first);
    expect(resumed.skip(row(), retryWhen)).toBe(true);
    expect(resumed.skip(row(), { ...retryWhen, maxPages: 6 })).toBe(false);
    expect(resumed.skip(row("b"), { ...retryWhen, searchPolicy: 2 })).toBe(false);
    expect(resumed.skip(row("c"), retryWhen)).toBe(false);
    expect(resumed.skip(row("d"), { ...retryWhen, searchPolicy: 2 })).toBe(true);
    expect(resumed.skip({ ...row(), title: "Changed" }, retryWhen)).toBe(false);
    resumed.close();
    const again = openRegistryReport("manganato", false, settings, third, second);
    try {
      expect(again.skip(row(), retryWhen)).toBe(true);
      expect(again.skip(row(), { ...retryWhen, maxPages: 6 })).toBe(false);
      expect(again.catalog).toEqual([catalog]);
      expect(again.skip(row("d"), { ...retryWhen, searchPolicy: 2 })).toBe(true);
      expect(again.skip({ ...row("d"), title: "Changed" }, retryWhen)).toBe(false);
    } finally {
      again.close();
    }
  });

  it.each(["mal", "mangadex", "kagane", "manganato", "xcomic"])(
    "%s skips completed checks but retries failures, missing checkpoints and incomplete evidence",
    (provider) => {
      const [first, second] = paths();
      const outcomes = [
        "matched",
        "ambiguous",
        "unmatched",
        "skipped",
        "errors",
        "conflicts",
        "challenged",
        "blocked",
      ];
      const report = openRegistryReport(provider, false, settings, first);
      for (const outcome of outcomes) report.entry(row(outcome), { outcome });
      report.entry(row("incomplete"), { outcome: "unmatched", retryable: true });
      report.close();
      const original = readFileSync(first!, "utf8");
      const resumed = openRegistryReport(provider, false, settings, second, first);
      try {
        expect(outcomes.filter((outcome) => resumed.skip(row(outcome)))).toEqual(
          outcomes.slice(0, 4),
        );
        expect(resumed.skip(row("incomplete"))).toBe(false);
        expect(resumed.skip(row("interrupted"))).toBe(false);
        expect(readFileSync(first!, "utf8")).toBe(original);
        expect(statSync(second!).mode & 0o777).toBe(0o600);
      } finally {
        resumed.close();
      }
    },
  );

  it("never drops dry-run matches when applying or a removed applied link when resuming", () => {
    for (const applied of [false, true]) {
      const [first, second] = paths();
      const report = openRegistryReport("manganato", applied, settings, first);
      report.entry(row(), { outcome: "matched", selectedId: "native-slug" });
      report.entry(row("b"), { outcome: "ambiguous" });
      report.close();
      const resumed = openRegistryReport("manganato", true, settings, second, first);
      try {
        expect(resumed.skip(row())).toBe(false);
        expect(resumed.skip(row("b"))).toBe(applied);
      } finally {
        resumed.close();
      }
    }
  });

  it("retains checkpoints across resume chains and lets a later failure replace success", () => {
    const [first, second, third] = paths();
    const report = openRegistryReport("xcomic", false, settings, first);
    report.entry(row("a"), { outcome: "ambiguous" });
    report.entry(row("b"), { outcome: "unmatched" });
    report.close();
    const resumed = openRegistryReport("xcomic", false, settings, second, first);
    resumed.entry(row("b"), { outcome: "errors" });
    resumed.entry(row("c"), { outcome: "unmatched" });
    resumed.close();
    const again = openRegistryReport("xcomic", false, settings, third, second);
    try {
      expect(["a", "b", "c", "d"].map((id) => again.skip(row(id)))).toEqual([
        true,
        false,
        true,
        false,
      ]);
    } finally {
      again.close();
    }
  });

  it("retries changed matching inputs but ignores timestamps and provider ordering", () => {
    const [first, second] = paths();
    const original = {
      ...row(),
      providers: [...row().providers, { provider: "mal" as const, externalId: "71", updatedAt: 1 }],
    };
    const report = openRegistryReport("kagane", false, settings, first);
    report.entry(original, { outcome: "ambiguous" });
    report.close();
    const resumed = openRegistryReport("kagane", false, settings, second, first);
    try {
      expect(
        resumed.skip({ ...original, updatedAt: 99, providers: [...original.providers].reverse() }),
      ).toBe(true);
      for (const changed of [
        { ...original, title: "Corrected title" },
        { ...original, providerId: "different" },
        {
          ...original,
          providers: [{ provider: "anilist" as const, externalId: "other", updatedAt: 1 }],
        },
        { ...original, state: { ...original.state!, status: "planning" as const } },
      ])
        expect(resumed.skip(changed)).toBe(false);
    } finally {
      resumed.close();
    }
  });

  it("rejects wrong providers, identity settings, origins, versions, and output overwrites", () => {
    const [first, second] = paths();
    const report = openRegistryReport("kagane", false, settings, first);
    report.close();
    expect(() => openRegistryReport("manganato", false, settings, second, first)).toThrow(
      /not a manganato/,
    );
    expect(() =>
      openRegistryReport("kagane", false, { ...settings, language: "ja" }, second, first),
    ).toThrow(/language differs/);
    expect(() =>
      openRegistryReport(
        "kagane",
        false,
        { ...settings, apiOrigin: "https://other.test" },
        second,
        first,
      ),
    ).toThrow(/apiOrigin differs/);
    expect(() => openRegistryReport("kagane", false, settings, first, first)).toThrow(/new file/);
    expect(() => openRegistryReport("kagane", false, settings, first)).toThrow(/EEXIST/);
    writeFileSync(
      first!,
      JSON.stringify({ event: "run", provider: "kagane", reportVersion: 2, settings }),
    );
    expect(() => openRegistryReport("kagane", false, settings, second, first)).toThrow(/version/);
  });

  it.each([
    [
      "manganato",
      { language: "en", identity: "exact title + author/artist; duplicate slugs stay ambiguous" },
    ],
    ["kagane", { language: "en", excludedSources: ["MangaDex"] }],
    ["xcomic", { language: "en", origin: "https://xcomic.me" }],
  ] satisfies [string, JsonObject][])(
    "resumes legacy %s reports by ID and title, including chains",
    (provider, header) => {
      const [first, second, third] = paths();
      writeFileSync(
        first!,
        [
          { event: "run", apply: true, ...header },
          { event: "entry", entryId: "a", title: "Title a", outcome: "ambiguous" },
          { event: "entry", entryId: "b", title: "Title b", outcome: "errors" },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
      const resumed = openRegistryReport(provider, true, settings, second, first);
      expect(resumed.skip(row())).toBe(true);
      expect(resumed.skip({ ...row(), title: "Changed title" })).toBe(false);
      expect(resumed.skip(row("b"))).toBe(false);
      resumed.close();
      const again = openRegistryReport(provider, true, settings, third, second);
      try {
        expect(again.skip(row())).toBe(true);
      } finally {
        again.close();
      }
    },
  );

  it("ignores an interrupted final write, but refuses earlier corruption or entries before a header", () => {
    const [first, second, third] = paths();
    const report = openRegistryReport("xcomic", false, settings, first);
    report.entry(row(), { outcome: "ambiguous" });
    report.close();
    appendFileSync(first!, '{"event":"entry","entryId":');
    const resumed = openRegistryReport("xcomic", false, settings, second, first);
    expect(resumed.skip(row())).toBe(true);
    resumed.close();
    appendFileSync(first!, '\n{"event":"summary"}\n');
    expect(() => openRegistryReport("xcomic", false, settings, third, first)).toThrow(
      /Invalid resume report line/,
    );
    writeFileSync(first!, '{"event":"entry","entryId":"a"}\n');
    expect(() => openRegistryReport("xcomic", false, settings, third, first)).toThrow(/precede/);
  });
});
