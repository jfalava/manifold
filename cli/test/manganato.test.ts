/** @effect-diagnostics asyncFunction:off */
import { describe, expect, it } from "vitest";
import type { BrowserView } from "../src/browser-view";
import {
  createManganatoClient,
  ManganatoBlockedError,
  selectManganatoCandidate,
  type ManganatoDetails,
} from "../src/manganato";

const identity = { titles: ["Giji Harem", "Pseudo Harem"], authors: ["Saitou Yuu"] };
const candidate: ManganatoDetails = {
  id: "pseudo-harem",
  title: "Pseudo-Harem",
  aliases: [],
  authors: ["Yuu Saitou"],
};

// Fixtures are browser transport responses; selection and pagination use the public client.
const clientFor = (responses: readonly unknown[], maxPages = 20) => {
  let index = 0;
  const view: BrowserView = {
    title: "MangaNato",
    url: "https://www.manganato.gg/",
    navigate: async () => {},
    close: () => {},
    cdp: async () => {
      throw new Error("Unexpected CDP request");
    },
    evaluate: async <T>() => {
      if (index >= responses.length) throw new Error("Unexpected additional browser request");
      // SAFETY: intentionally emulate the untrusted wire return from BrowserView.evaluate.
      return responses[index++] as T;
    },
  };
  return createManganatoClient({ view, delay: 0, maxPages });
};
const page = (ids: readonly string[], next: string | null = null) => ({
  status: 200,
  challenged: false,
  data: {
    title: "Search Results for pseudo",
    items: ids.map((id) => ({ id, title: "Pseudo Harem" })),
    next,
  },
});

describe("MangaNato identity and complete search", () => {
  it("accepts an alias and reversed author order, without depending on result order", () => {
    expect(
      selectManganatoCandidate(identity, [
        { ...candidate, id: "sequel", title: "Pseudo Harem 2" },
        candidate,
      ])?.id,
    ).toBe("pseudo-harem");
    expect(
      selectManganatoCandidate(identity, [
        { ...candidate, authors: ["Other Creator", "Yuu Saitou (斉藤ゆう)"] },
      ])?.id,
    ).toBe("pseudo-harem");
  });

  it("retains numbers and edition suffixes and requires author corroboration", () => {
    for (const change of [
      { title: "Pseudo Harem 2" },
      { title: "Pseudo Harem Official Anthology" },
      { authors: [] },
      { authors: ["Saitou Yuki"] },
      { authors: ["Unknown"] },
    ])
      expect(selectManganatoCandidate(identity, [{ ...candidate, ...change }])).toBeUndefined();
    expect(selectManganatoCandidate({ ...identity, authors: [] }, [candidate])).toBeUndefined();
  });

  it("does not eliminate duplicate slugs using missing or contradictory author credits", () => {
    for (const authors of [candidate.authors, [], ["Someone Else"]]) {
      expect(
        selectManganatoCandidate(identity, [candidate, { ...candidate, id: "duplicate", authors }]),
      ).toBeUndefined();
    }
    expect(selectManganatoCandidate(identity, [candidate, candidate])?.id).toBe(candidate.id);
  });

  it("returns competitors from later pages rather than selecting the first hit", async () => {
    const client = clientFor([page(["one"], "/search/story/pseudo?page=2"), page(["one", "two"])]);
    expect((await client.search("pseudo")).map((hit) => hit.id)).toEqual(["one", "two"]);
    expect((await client.search("pseudo")).map((hit) => hit.id)).toEqual(["one", "two"]);
  });

  it("rejects incomplete, repeated, off-site and nonadvancing pagination", async () => {
    for (const next of [
      "/search/story/pseudo?page=1",
      "https://evil.test/search/story/pseudo?page=2",
      "/search/story/changed?page=2",
      "/search/story/pseudo?page=NaN",
    ]) {
      await expect(clientFor([page(["one"], next)]).search("pseudo")).rejects.toThrow(/pagination/);
    }
    await expect(
      clientFor([page(["one"], "/search/story/pseudo?page=2")], 1).search("pseudo"),
    ).rejects.toThrow(/Incomplete/);
    await expect(
      clientFor([page(["one"], "/search/story/pseudo?page=2"), page(["one"])]).search("pseudo"),
    ).rejects.toThrow(/repeated/);
  });

  it("distinguishes a real empty result from access restrictions and malformed responses", async () => {
    expect(await clientFor([page([])]).search("pseudo")).toEqual([]);
    for (const response of [
      { status: 200, challenged: true, data: null },
      { status: 403, challenged: false, data: null },
      { status: 429, challenged: false, data: null },
    ])
      await expect(clientFor([response]).search("pseudo")).rejects.toBeInstanceOf(
        ManganatoBlockedError,
      );
    await expect(
      clientFor([{ status: 200, challenged: false, data: { items: [], next: null } }]).search(
        "pseudo",
      ),
    ).rejects.toThrow();
  });
});
