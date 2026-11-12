import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cachedMatchesFor, phaseMatch, type MdLibraryEntry } from "../src/md2al-core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "manifold-md2al-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const entry = (mangaDexId: string, status: MdLibraryEntry["status"]): MdLibraryEntry => ({
  mangaDexId,
  status,
  title: mangaDexId,
  altTitles: [],
});

/** A match file from an earlier run, when both titles were still being read. */
const writeEarlierMatches = (): void => {
  writeFileSync(
    join(tmpDir, "md-match-results.json"),
    JSON.stringify([
      { mangaDexId: "finished", status: "reading", anilistId: "101", method: "links-al" },
      { mangaDexId: "outside-limit", status: "reading", anilistId: "102", method: "links-al" },
    ]),
  );
};

describe("md2al cached matches", () => {
  it("phaseMatch takes the status from the snapshot, not the match file", async () => {
    writeEarlierMatches();

    const matches = await phaseMatch("token", [entry("finished", "completed")], tmpDir);

    expect(matches).toEqual([
      { mangaDexId: "finished", status: "completed", anilistId: "101", method: "links-al" },
    ]);
  });

  it("cachedMatchesFor keeps only the given entries, with their snapshot status", () => {
    writeEarlierMatches();

    expect(
      cachedMatchesFor(tmpDir, [entry("finished", "completed"), entry("never-matched", "reading")]),
    ).toEqual([
      { mangaDexId: "finished", status: "completed", anilistId: "101", method: "links-al" },
    ]);
  });
});
