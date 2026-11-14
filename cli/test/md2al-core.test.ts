import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@manifold/json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedMatchesFor,
  collectProgress,
  phaseExport,
  phaseMatch,
  type MdLibraryEntry,
} from "../src/md2al-core";
import { parseJsonArray } from "./support/report";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "manifold-md2al-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const readMatchFile = (): readonly JsonValue[] =>
  parseJsonArray(readFileSync(join(tmpDir, "md-match-results.json"), "utf8"));

/** Stub fetch with one handler and return the URLs it was asked for. */
const stubFetch = (respond: (url: URL) => Response): URL[] => {
  const requests: URL[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      requests.push(url);

      return respond(url);
    }),
  );

  return requests;
};

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

describe("md2al MangaDex lookups", () => {
  it("asks for every content rating when it loads the shelf titles", async () => {
    const requests = stubFetch((url) =>
      url.pathname === "/manga/status"
        ? Response.json({ statuses: { adult: "reading" } })
        : Response.json({
            data: [
              { id: "adult", attributes: { title: { en: "Adult title" }, links: { al: "7" } } },
            ],
          }),
    );

    const entries = await phaseExport(async () => "md-token", tmpDir);

    expect(entries).toEqual([
      {
        mangaDexId: "adult",
        status: "reading",
        title: "Adult title",
        altTitles: [],
        anilistId: "7",
      },
    ]);
    expect(requests[1]?.searchParams.getAll("contentRating[]")).toEqual([
      "safe",
      "suggestive",
      "erotica",
      "pornographic",
    ]);
  });

  it("reads the highest chapter number from the read markers", async () => {
    const requests = stubFetch((url) =>
      url.pathname === "/manga/m1/read"
        ? Response.json({ data: ["c1", "c2"] })
        : Response.json({
            data: [
              { id: "c1", attributes: { chapter: "3" } },
              { id: "c2", attributes: { chapter: "12.5" } },
            ],
          }),
    );

    const progress = await collectProgress(async () => "md-token", [entry("m1", "reading")]);

    expect([...progress]).toEqual([["m1", 12]]);
    expect(requests[1]?.searchParams.getAll("contentRating[]")).toContain("pornographic");
  });

  it("stops retrying a MangaDex request that keeps answering 403", async () => {
    vi.useFakeTimers();

    const requests = stubFetch((url) =>
      url.pathname === "/manga/status"
        ? Response.json({ statuses: { m1: "reading" } })
        : new Response("blocked", { status: 403 }),
    );

    const outcome = phaseExport(async () => "md-token", tmpDir).then(
      () => "exported",
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(outcome).resolves.toContain("MangaDex HTTP 403 for /manga?");
    expect(requests.filter((url) => url.pathname === "/manga")).toHaveLength(5);
  });
});

describe("md2al match phase with a failing AniList", () => {
  const unlinked = (id: string): MdLibraryEntry => ({
    ...entry(id, "reading"),
    title: `Title ${id}`,
  });

  it("does not save a failed lookup as unmatched, and keeps earlier matches it did not reach", async () => {
    vi.useFakeTimers();
    writeEarlierMatches();
    stubFetch(() => new Response("{}", { status: 500 }));

    const outcome = phaseMatch(
      "token",
      [...["a", "b", "c", "d", "e"].map(unlinked), entry("finished", "completed")],
      tmpDir,
    ).then(
      () => "matched",
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(outcome).resolves.toContain("AniList lookups failed 5 times in a row");
    expect(readMatchFile()).toEqual([
      { mangaDexId: "finished", status: "reading", anilistId: "101", method: "links-al" },
      { mangaDexId: "outside-limit", status: "reading", anilistId: "102", method: "links-al" },
    ]);
  });

  it("saves a title AniList answered for without a match as unmatched", async () => {
    vi.useFakeTimers();
    stubFetch(() => Response.json({ data: { Page: { media: [] } } }));

    const outcome = phaseMatch("token", [unlinked("a")], tmpDir);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(outcome).resolves.toEqual([{ mangaDexId: "a", status: "reading" }]);
    expect(readMatchFile()).toEqual([{ mangaDexId: "a", status: "reading" }]);
  });
});
