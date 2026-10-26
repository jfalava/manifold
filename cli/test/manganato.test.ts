/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@manifold/json";
import type { BrowserView } from "../src/browser-view";
import {
  createManganatoClient,
  loadManganatoChapterReference,
  loadManganatoIdentity,
  ManganatoBlockedError,
  ManganatoPageBudgetError,
  manganatoMatchEvidence,
  manganatoRescueQueries,
  manganatoSearchPlans,
  recommendManganatoCandidate,
  selectManganatoCandidate,
  type ManganatoChapterReference,
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
const clientFor = (
  responses: readonly unknown[],
  maxPages = 20,
  options: {
    catalog?: readonly JsonObject[];
    onCache?: (record: JsonObject) => void;
    onBlocked?: (error: ManganatoBlockedError) => Promise<void>;
    execute?: (script: string) => Promise<unknown>;
  } = {},
) => {
  let index = 0;
  const view: BrowserView = {
    title: "MangaNato",
    url: "https://www.manganato.gg/",
    navigate: async () => {},
    close: () => {},
    cdp: async () => {
      throw new Error("Unexpected CDP request");
    },
    evaluate: async <T>(script: string) => {
      // SAFETY: browser script results deliberately cross an untrusted transport boundary.
      if (options.execute) return (await options.execute(script)) as T;
      if (index >= responses.length) throw new Error("Unexpected additional browser request");
      const response = responses[index++];
      if (response instanceof Error) throw response;
      // SAFETY: intentionally emulate the untrusted wire return from BrowserView.evaluate.
      return response as T;
    },
  };
  const client = createManganatoClient({ view, delay: 0, maxPages, ...options });
  return {
    details: client.details,
    coverage: client.coverage,
    search: async (query: string) => {
      const results: ManganatoDetails[] = [];
      for await (const hits of client.search(query)) results.push(...hits);
      return results;
    },
  };
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
  it("prioritizes English and romanized discovery without discarding other identity aliases", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: {
          attributes: {
            title: { ja: "日本語" },
            altTitles: [
              { fr: "Une Autre Histoire" },
              { en: "Quasar Nebula" },
              { "ja-ro": "Giji Harem" },
            ],
          },
          relationships: [{ type: "author", attributes: { name: "Creator" } }],
        },
      }),
    );
    try {
      const identity = await loadManganatoIdentity(
        { title: "Original Romaji", providers: [{ provider: "mangadex", externalId: "md-id" }] },
        () => {},
      );
      expect(manganatoSearchPlans(identity.discoveryTitles).map((plan) => plan.title)).toEqual([
        "Quasar Nebula",
        "Giji Harem",
      ]);
      expect(identity.fallbackTitles).toEqual(["Original Romaji", "Quasar Nebula", "Giji Harem"]);
      expect(identity.titles).toContain("Original Romaji");
      expect(identity.titles).toContain("Une Autre Histoire");
      expect(identity.titles).toContain("日本語");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("chooses distinctive Latin words before broad genre terms, deduplicating near-identical aliases", () => {
    expect(
      manganatoSearchPlans([
        "Reincarnated into a Nebula World with Quasar Love",
        "Reincarnated in a Nebula World with Quasar Love",
        "エロゲ世界",
        "Eroge Sekai ni Tensei Shita Ore ga Netorare Heroine wo Shiawase ni Suru",
      ]).map((plan) => plan.queries),
    ).toEqual([
      ["netorare", "shiawase"],
      ["nebula", "quasar"],
    ]);
    expect(manganatoSearchPlans(["86"])[0]?.queries).toEqual(["86"]);
    expect(manganatoSearchPlans(["The Ki Sisters", "Young Again", "The Law"])).toEqual([]);
    expect(manganatoSearchPlans(["Pseudo Harem"])[0]?.queries).toEqual(["pseudo"]);
    expect(
      manganatoSearchPlans(["Welcome Back Home", "Okaeri"]).map((plan) => plan.queries),
    ).toEqual([["okaeri"], ["welcome", "back"]]);
  });

  it("shares six rescue queries across overlapping canonical titles without retrying planned words", () => {
    expect(
      manganatoRescueQueries(
        [
          "Distinctive Exclusive Quasar Nebula Pulsar Meteor Galaxy",
          "Distinctive Exclusive Quasar Nebula Pulsar Meteor Galaxy",
          "Distinctive Exclusive Quasar Nebula Saturn Uranus Cosmos",
          "Distinctive Exclusive Quasar Nebula Saturn Europa Oberon",
          "日本語",
        ],
        ["distinctive", "exclusive"],
      ),
    ).toEqual(["quasar", "nebula", "saturn", "pulsar", "uranus", "europa"]);
  });

  it("saves validated pages and successful details without treating a partial search as complete", async () => {
    const catalog: JsonObject[] = [];
    const client = clientFor(
      [page(["one"]), { status: 200, challenged: false, data: candidate }],
      5,
      { onCache: (record) => catalog.push(record) },
    );
    await client.search("Pseudo");
    await client.details(candidate.id);
    expect(catalog.map((record) => record.kind)).toEqual(["page", "details"]);
    const resumed = clientFor([], 5, { catalog });
    expect((await resumed.search("PSEUDO")).map((hit) => hit.id)).toEqual(["one"]);
    expect(await resumed.details(candidate.id)).toEqual(candidate);
    expect(
      await clientFor([], 5, {
        catalog: [
          {
            event: "catalog",
            version: 1,
            origin: "https://www.manganato.gg",
            kind: "search",
            key: "pseudo",
            savedAt: Date.now(),
            data: [candidate],
          },
        ],
      }).search("pseudo"),
    ).toEqual([candidate]);
    const partial: JsonObject[] = [];
    const capped = clientFor([page(["one"], "/search/story/pseudo?page=2")], 1, {
      onCache: (record) => partial.push(record),
    });
    await expect(capped.search("pseudo")).rejects.toBeInstanceOf(ManganatoPageBudgetError);
    expect(partial).toHaveLength(1);
    await expect(clientFor([], 1, { catalog: partial }).search("pseudo")).rejects.toBeInstanceOf(
      ManganatoPageBudgetError,
    );
    expect(
      (await clientFor([page(["two"])], 2, { catalog: partial }).search("pseudo")).map(
        (hit) => hit.id,
      ),
    ).toEqual(["one", "two"]);
  });

  it("does not renew old page timestamps when a later resume finishes the query", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
      const catalog: JsonObject[] = [];
      await expect(
        clientFor([page(["one"], "/search/story/pseudo?page=2")], 1, {
          onCache: (record) => catalog.push(record),
        }).search("pseudo"),
      ).rejects.toBeInstanceOf(ManganatoPageBudgetError);
      vi.setSystemTime(new Date("2026-10-24T18:00:00Z"));
      expect(
        (
          await clientFor([page(["two"])], 2, {
            catalog,
            onCache: (record) => catalog.push(record),
          }).search("pseudo")
        ).map((hit) => hit.id),
      ).toEqual(["one", "two"]);
      vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
      expect(
        (
          await clientFor([page(["updated"], "/search/story/pseudo?page=2")], 2, {
            catalog,
          }).search("pseudo")
        ).map((hit) => hit.id),
      ).toEqual(["updated", "two"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires cached catalog reads at 24 hours and rejects wrong origins or mismatched details", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
      const catalog: JsonObject[] = [];
      await clientFor([page(["old"])], 5, { onCache: (record) => catalog.push(record) }).search(
        "pseudo",
      );
      vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
      expect((await clientFor([page(["new"])], 5, { catalog }).search("pseudo"))[0]?.id).toBe(
        "new",
      );
      const invalid = [
        { ...catalog[0]!, origin: "https://other.test", savedAt: Date.now() },
        { ...catalog[0]!, query: "different", savedAt: Date.now() },
        { ...catalog[0]!, savedAt: Date.now() + 1 },
        {
          ...catalog[0]!,
          kind: "details",
          key: candidate.id,
          data: [{ ...candidate, id: "wrong" }],
          savedAt: Date.now(),
        },
      ];
      expect(
        (await clientFor([page(["live"])], 5, { catalog: invalid }).search("pseudo"))[0]?.id,
      ).toBe("live");
      expect(
        await clientFor([{ status: 200, challenged: false, data: candidate }], 5, {
          catalog: invalid,
        }).details(candidate.id),
      ).toEqual(candidate);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("accepts confirmed full-author romanizations in either direction without fuzzy name collisions", () => {
    for (const [first, second] of [
      ["Sano Yuto", "Yuuto Sano"],
      ["Ohtsuki Ichika", "Ootsuki Ichika"],
      ["Matsuena Shun", "Syun Matsuena"],
      ["Maijo Ohtaro", "Maijou Outarou"],
      ["Yoneshiro Kyou", "Kyo Yoneshiro"],
      ["Atou Rie", "Ato Rie"],
      ["Ookubo Atsushi", "Ohkubo Atsushi"],
      ["Soumatou", "Somato"],
      ["Naito Marcey", "Naitou Marcey"],
      ["Kitou Sakeru", "Sakeru Kito"],
      ["Ohno Tsutomu", "Tsutomu Oono"],
      ["Necoco", "Nekoko"],
    ] as const) {
      for (const [expected, actual] of [
        [first, second],
        [second, first],
      ]) {
        expect(
          selectManganatoCandidate({ ...identity, authors: [expected!] }, [
            {
              ...candidate,
              authors: [actual!.split(" ").reverse().join(" ").toUpperCase() + " (Story & Art)"],
            },
          ])?.id,
        ).toBe(candidate.id);
      }
    }
    for (const [expected, actual] of [
      ["Sano Yuki", "Sano Yuuki"],
      ["Atou Ren", "Ato Ren"],
      ["Rico Tanaka", "Riko Tanaka"],
      ["Sano Yuto", "Yuto"],
      ["Ohtsuki Ichika", "Ootsuki Ichika Other"],
    ] as const) {
      expect(
        selectManganatoCandidate({ ...identity, authors: [expected] }, [
          { ...candidate, authors: [actual] },
        ]),
      ).toBeUndefined();
    }
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

  it("adds chapter support for different credits without using counts as a veto or excusing missing authors", () => {
    const chapterReference: ManganatoChapterReference = {
      provider: "anilist",
      providerId: "123",
      titles: ["Pseudo Harem"],
      chapters: 20,
      status: "FINISHED",
    };
    const withReference = { ...identity, chapterReference };
    const different = {
      ...candidate,
      authors: ["Different Pen Name"],
      coverage: {
        unit: "chapters" as const,
        count: 19,
        numbers: Array.from({ length: 19 }, (_, i) => i + 1),
      },
    };
    expect(selectManganatoCandidate(withReference, [different])?.id).toBe(candidate.id);
    expect(manganatoMatchEvidence(withReference, different)).toMatchObject({
      author: "different",
      chapterSupport: true,
      score: 85,
      eligible: true,
    });
    for (const reference of [
      { ...chapterReference, chapters: null },
      { ...chapterReference, chapters: 0 },
      { ...chapterReference, chapters: 9 },
      { ...chapterReference, status: "RELEASING" },
      { ...chapterReference, titles: ["Pseudo Harem 2"] },
      { ...chapterReference, chapters: 100 },
    ]) {
      expect(
        selectManganatoCandidate({ ...identity, chapterReference: reference }, [different]),
      ).toBeUndefined();
      expect(
        selectManganatoCandidate({ ...identity, chapterReference: reference }, [candidate])?.id,
      ).toBe(candidate.id);
    }
    for (const authors of [[], ["Unknown"], ["Updating"], ["   "]]) {
      expect(selectManganatoCandidate(withReference, [{ ...different, authors }])).toBeUndefined();
      expect(selectManganatoCandidate({ ...withReference, authors }, [different])).toBeUndefined();
    }
    for (const numbers of [
      Array.from({ length: 18 }, (_, i) => i + 1),
      Array.from({ length: 22 }, (_, i) => i + 1),
      Array.from({ length: 20 }, (_, i) => i + 2),
      [...different.coverage.numbers, 5000],
      Array.from({ length: 20 }, (_, i) => Math.floor(i / 2) + 1 + (i % 2 ? 0.5 : 0)),
    ]) {
      expect(
        selectManganatoCandidate(withReference, [
          { ...different, coverage: { unit: "chapters", count: numbers.length, numbers } },
        ]),
      ).toBeUndefined();
    }
    expect(
      selectManganatoCandidate(withReference, [
        { ...different, title: "Pseudo Harem Official Anthology" },
      ]),
    ).toBeUndefined();
  });

  it("uses ten shared integers and 95% overlap as identity support but keeps competing coverage manual", () => {
    const listing = (id: string, authors: readonly string[], numbers: number[]) => ({
      ...candidate,
      id,
      authors,
      coverage: { unit: "chapters" as const, count: numbers.length, numbers },
    });
    const anchor = listing(
      "anchor",
      candidate.authors,
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const supported = listing(
      "supported",
      ["Different Creator"],
      [...Array.from({ length: 20 }, (_, i) => i + 2), 20.5],
    );
    for (const pool of [
      [anchor, supported],
      [supported, anchor],
    ]) {
      // The supported listing is missing chapter 1, despite having a larger count.
      expect(selectManganatoCandidate(identity, pool)).toBeUndefined();
      expect(manganatoMatchEvidence(identity, supported, pool)).toMatchObject({
        author: "different",
        score: 85,
        overlap: [{ anchorId: "anchor", shared: 19, smaller: 20, fraction: 0.95 }],
      });
    }
    for (const other of [
      listing(
        "below",
        ["Different Creator"],
        Array.from({ length: 20 }, (_, i) => i + 3),
      ),
      listing(
        "nine",
        ["Different Creator"],
        Array.from({ length: 9 }, (_, i) => i + 1),
      ),
      listing(
        "fractions",
        ["Different Creator"],
        Array.from({ length: 20 }, (_, i) => i + 1.5),
      ),
      { ...supported, authors: ["Unknown"] },
      { ...supported, coverage: undefined },
      { ...supported, title: "Pseudo Harem 2" },
    ])
      expect(manganatoMatchEvidence(identity, other, [anchor, other]).eligible).toBe(false);
    const short = listing(
      "short",
      ["Different Creator"],
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(selectManganatoCandidate(identity, [short, anchor])?.id).toBe("anchor");
    expect(
      selectManganatoCandidate(identity, [anchor, { ...supported, coverage: anchor.coverage }]),
    ).toBeUndefined();
    expect(selectManganatoCandidate(identity, [supported])).toBeUndefined();
  });

  it("recommends missing-credit duplicates without granting eligibility or changing identities", () => {
    const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
    const anchor = {
      ...candidate,
      id: "anchor",
      coverage: { unit: "chapters" as const, count: 20, numbers, latestChapterUpdatedAt: 100 },
    };
    const missing = {
      ...candidate,
      id: "missing",
      authors: [],
      coverage: {
        unit: "chapters" as const,
        count: 21,
        numbers: [...numbers, 21],
        latestChapterUpdatedAt: 200,
      },
    };
    const original = JSON.stringify(identity);
    for (const pool of [
      [anchor, missing],
      [missing, anchor],
    ]) {
      expect(recommendManganatoCandidate(identity, pool)).toMatchObject({
        candidateId: "missing",
        basis: "missing-credit-inference",
        requiresOptIn: true,
        acceptEligible: true,
        inferred: [
          { candidateId: "missing", overlap: [{ anchorId: "anchor", shared: 20, fraction: 1 }] },
        ],
      });
      expect(selectManganatoCandidate(identity, pool)).toBeUndefined();
      expect(manganatoMatchEvidence(identity, missing, pool)).toMatchObject({
        author: "missing",
        userConfirmed: false,
        chapterSupport: false,
        score: 60,
        eligible: false,
      });
    }
    expect(JSON.stringify(identity)).toBe(original);
    const smaller = {
      ...missing,
      coverage: { ...anchor.coverage, count: 10, numbers: numbers.slice(0, 10) },
    };
    expect(recommendManganatoCandidate(identity, [anchor, smaller])?.candidateId).toBe("anchor");
    const equal = { ...missing, coverage: { ...anchor.coverage, latestChapterUpdatedAt: 200 } };
    expect(recommendManganatoCandidate(identity, [anchor, equal])?.candidateId).toBe("missing");
    expect(
      recommendManganatoCandidate(identity, [anchor, { ...equal, coverage: anchor.coverage }]),
    ).toBeUndefined();
    expect(
      recommendManganatoCandidate(identity, [
        anchor,
        { ...equal, coverage: { ...anchor.coverage, latestChapterUpdatedAt: undefined } },
      ]),
    ).toBeUndefined();
    for (const other of [
      { ...smaller, coverage: { ...smaller.coverage, count: 9, numbers: numbers.slice(0, 9) } },
      {
        ...missing,
        coverage: { unit: "unknown" as const, count: 21, numbers: missing.coverage.numbers },
      },
      { ...missing, coverage: { ...missing.coverage, numbers: [...numbers.slice(1), 20.5, 21] } },
      { ...missing, title: "Different work" },
    ])
      expect(recommendManganatoCandidate(identity, [anchor, other])).toBeUndefined();
    expect(
      recommendManganatoCandidate({ ...identity, manualReview: true }, [anchor, missing]),
    ).toBeUndefined();
    expect(
      recommendManganatoCandidate({ ...identity, preferredCandidateId: "anchor" }, [
        anchor,
        missing,
      ]),
    ).toBeUndefined();
    expect(
      recommendManganatoCandidate(identity, [{ ...anchor, authors: [] }, missing]),
    ).toBeUndefined();
    expect(
      recommendManganatoCandidate({ ...identity, confirmedCandidateIds: ["anchor"] }, [
        { ...anchor, authors: [] },
        missing,
      ]),
    ).toBeUndefined();
  });

  it("exposes the 95% direct-anchor boundary without chaining recommendations or hiding editions in aliases", () => {
    const listing = (id: string, first: number, count: number) => ({
      ...candidate,
      id,
      authors: [],
      coverage: {
        unit: "chapters" as const,
        count,
        numbers: Array.from({ length: count }, (_, i) => first + i),
      },
    });
    const anchor = { ...listing("anchor", 1, 100), authors: candidate.authors };
    const supported = listing("supported", 6, 100);
    expect(manganatoMatchEvidence(identity, supported, [anchor, supported]).overlap).toMatchObject([
      { anchorId: "anchor", shared: 95, smaller: 100, fraction: 0.95 },
    ]);
    const below = listing("below", 7, 100);
    expect(manganatoMatchEvidence(identity, below, [anchor, below]).overlap).toEqual([]);
    const bridge = listing("bridge", 6, 105);
    const chained = listing("chained", 11, 100);
    expect(recommendManganatoCandidate(identity, [anchor, bridge, chained])).toBeUndefined();
    const missing = listing("missing", 1, 101);
    expect(recommendManganatoCandidate(identity, [anchor, missing])?.candidateId).toBe("missing");
    for (const edition of [
      "Side Stories",
      "Side–Stories",
      "Side: Stories",
      "Ｓｉｄｅ Ｓｔｏｒｉｅｓ",
      "Spin-off",
      "Pre-serialization",
      "One-shot",
      "Novel",
      "Anthology",
      "Sequel",
      "Remake",
      "Full Color",
    ]) {
      for (const pool of [
        [{ ...anchor, title: `Pseudo Harem ${edition}`, aliases: ["Pseudo Harem"] }, missing],
        [anchor, { ...missing, title: `Pseudo Harem ${edition}`, aliases: ["Pseudo Harem"] }],
      ])
        expect(recommendManganatoCandidate(identity, pool)).toBeUndefined();
    }
  });

  it("selects a newer advancing integer run and reports lost zero/fractional positions without weakening identity", () => {
    const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
    const listing = (id: string, numbers: number[], date = 100) => ({
      ...candidate,
      id,
      coverage: {
        unit: "chapters" as const,
        count: numbers.length,
        numbers,
        latestChapterUpdatedAt: date,
      },
    });
    // The older listing has MORE positions, but the newer one advances the integer run.
    const older = listing("older", [0, ...numbers, 1.5, 2.5]);
    const advancing = listing("advancing", [...numbers, 21], 200);
    for (const pool of [
      [older, advancing],
      [advancing, older],
    ]) {
      expect(selectManganatoCandidate(identity, pool)).toMatchObject({
        id: "advancing",
        selection: {
          basis: "active-listing",
          lostPositions: [{ candidateId: "older", numbers: [0, 1.5, 2.5] }],
        },
      });
    }
    for (const other of [
      listing("same-integers", [...numbers, 3.5], 200),
      listing("older-date", [...numbers, 21], 99),
      listing("same-date", [...numbers, 21], 100),
      listing("integer-gap", [...numbers.slice(1), 21], 200),
      listing("outlier", [...numbers, 5000], 200),
      { ...advancing, coverage: { ...advancing.coverage, unit: "unknown" as const } },
      { ...advancing, coverage: { ...advancing.coverage, latestChapterUpdatedAt: undefined } },
      { ...advancing, authors: [] },
      { ...advancing, title: "Pseudo Harem Side–Stories", aliases: ["Pseudo Harem"] },
    ]) {
      expect(selectManganatoCandidate(identity, [older, other])).toBeUndefined();
    }
    const additionalInteger = listing("additional-integer", [...numbers, 22], 150);
    expect(
      selectManganatoCandidate(identity, [older, advancing, additionalInteger]),
    ).toBeUndefined();
    expect(
      selectManganatoCandidate({ ...identity, manualReview: true }, [older, advancing]),
    ).toBeUndefined();
    expect(
      selectManganatoCandidate({ ...identity, preferredCandidateId: "absent" }, [older, advancing]),
    ).toBeUndefined();
    expect(
      selectManganatoCandidate(identity, [
        { ...older, title: "Pseudo Harem One-shot", aliases: ["Pseudo Harem"] },
        advancing,
      ]),
    ).toBeUndefined();

    const inferred = { ...advancing, authors: [] };
    expect(recommendManganatoCandidate(identity, [older, inferred])).toMatchObject({
      candidateId: "advancing",
      acceptEligible: true,
      selection: {
        basis: "active-listing",
        lostPositions: [{ candidateId: "older", numbers: [0, 1.5, 2.5] }],
      },
    });
    expect(manganatoMatchEvidence(identity, inferred, [older, inferred]).eligible).toBe(false);
    // Strict hypothetical ranking may still suggest an outlier, but opt-in cannot accept it.
    const sparse = { ...listing("sparse", [...older.coverage.numbers, 5000], 200), authors: [] };
    expect(recommendManganatoCandidate(identity, [older, sparse])).toMatchObject({
      candidateId: "sparse",
      requiresOptIn: true,
      acceptEligible: false,
    });
  });

  it("never chains overlap rescues or silently confirms probable joined-name aliases", () => {
    const listing = (id: string, authors: readonly string[], first: number, count: number) => ({
      ...candidate,
      id,
      authors,
      coverage: {
        unit: "chapters" as const,
        count,
        numbers: Array.from({ length: count }, (_, i) => first + i),
      },
    });
    const anchor = listing("anchor", candidate.authors, 1, 20);
    const rescued = listing("rescued", ["Different Creator"], 1, 40);
    const transitive = listing("transitive", ["Third Creator"], 21, 20);
    for (const pool of [
      [anchor, rescued, transitive],
      [transitive, rescued, anchor],
    ]) {
      expect(manganatoMatchEvidence(identity, rescued, pool).eligible).toBe(true);
      expect(manganatoMatchEvidence(identity, transitive, pool).eligible).toBe(false);
      expect(selectManganatoCandidate(identity, pool)).toBeUndefined();
    }
    expect(
      manganatoMatchEvidence(
        { ...identity, authors: ["Kanalina"] },
        { ...rescued, authors: ["Lina Kana"] },
      ),
    ).toMatchObject({
      author: "different",
      eligible: false,
      authorAliasSuggestions: [
        { expected: "Kanalina", actual: "Lina Kana", status: "unconfirmed" },
      ],
    });
  });

  it("keeps most-coverage ranking after chapter-supported identity, retaining unresolved competitors and ties", () => {
    const withReference = {
      ...identity,
      chapterReference: {
        provider: "anilist" as const,
        providerId: "123",
        titles: ["Pseudo Harem"],
        chapters: 20,
        status: "FINISHED",
      },
    };
    const supported = {
      ...candidate,
      authors: ["Different Pen Name"],
      coverage: {
        unit: "chapters" as const,
        count: 20,
        numbers: Array.from({ length: 20 }, (_, i) => i + 1),
      },
    };
    const larger = {
      ...candidate,
      id: "larger",
      coverage: {
        unit: "chapters" as const,
        count: 24,
        numbers: Array.from({ length: 24 }, (_, i) => i + 1),
      },
    };
    expect(selectManganatoCandidate(withReference, [supported, larger])?.id).toBe("larger");
    expect(selectManganatoCandidate(withReference, [larger, supported])?.id).toBe("larger");
    expect(
      selectManganatoCandidate(withReference, [
        supported,
        { ...larger, coverage: supported.coverage },
      ]),
    ).toBeUndefined();
    expect(
      selectManganatoCandidate(withReference, [
        supported,
        {
          ...larger,
          authors: ["Different Author"],
          coverage: { ...larger.coverage, numbers: Array.from({ length: 24 }, (_, i) => 50 + i) },
        },
      ]),
    ).toBeUndefined();
    expect(
      selectManganatoCandidate(withReference, [supported, { ...larger, authors: [] }]),
    ).toBeUndefined();
  });

  it("loads chapter evidence by bound MAL ID and rejects contradictory or unavailable canonical records", async () => {
    let idMal = 456;
    let failed = false;
    vi.stubGlobal("fetch", async (_input, init) => {
      const { variables } = JSON.parse(String(init.body));
      if (failed) return new Response("unavailable", { status: 503 });
      if (variables.idMal !== 456) return Response.json({ data: { Media: null } });
      return Response.json({
        data: {
          Media: {
            id: 123,
            idMal,
            title: { english: "Pseudo Harem" },
            synonyms: [],
            chapters: 20,
            status: "FINISHED",
          },
        },
      });
    });
    const row = { providers: [{ provider: "mal", externalId: "456" }] };
    const incomplete = () => {};
    try {
      const reference = await loadManganatoChapterReference(row, () => {}, incomplete);
      expect(reference).toMatchObject({
        provider: "anilist",
        providerId: "123",
        chapters: 20,
        status: "FINISHED",
      });
      expect(reference?.titles).toContain("Pseudo Harem");
      idMal = 999;
      expect(await loadManganatoChapterReference(row, () => {}, incomplete)).toBeUndefined();
      failed = true;
      expect(await loadManganatoChapterReference(row, () => {}, incomplete)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);

  it("selects the uniquely most-covered identity-verified duplicate, never using counts to excuse missing authors", () => {
    const small = {
      ...candidate,
      coverage: { unit: "chapters" as const, count: 2, numbers: [1, 2] },
    };
    const large = {
      ...candidate,
      id: "larger",
      coverage: { unit: "chapters" as const, count: 3, numbers: [1, 2, 3] },
    };
    expect(selectManganatoCandidate(identity, [small, large])?.id).toBe("larger");
    expect(selectManganatoCandidate(identity, [large, small])?.id).toBe("larger");
    for (const other of [
      { ...large, coverage: small.coverage },
      { ...large, coverage: undefined },
      { ...large, coverage: { ...large.coverage, unit: "unknown" as const } },
      { ...large, authors: [] },
      { ...large, authors: ["Other Creator"] },
    ])
      expect(selectManganatoCandidate(identity, [small, other])).toBeUndefined();
  });

  it("scopes user-confirmed listings to their bound work and keeps publication-version conflicts manual", async () => {
    const confirmed = await loadManganatoIdentity(
      { title: "Kichiku Eiyuu", providers: [{ provider: "anilist", externalId: "139415" }] },
      () => {},
    );
    const listing = {
      id: "savage-hero",
      title: "Savage Hero",
      aliases: [],
      authors: [],
    };
    expect(selectManganatoCandidate(confirmed, [listing])?.id).toBe("savage-hero");
    expect(manganatoMatchEvidence(confirmed, listing)).toMatchObject({
      userConfirmed: true,
      author: "missing",
      eligible: true,
    });
    expect(selectManganatoCandidate(confirmed, [{ ...listing, id: "unreviewed" }])).toBeUndefined();
    expect(
      selectManganatoCandidate(confirmed, [{ ...listing, title: "Savage Hero 2" }]),
    ).toBeUndefined();
    const unrelated = await loadManganatoIdentity(
      { title: "Savage Hero", providers: [{ provider: "anilist", externalId: "999" }] },
      () => {},
    );
    expect(selectManganatoCandidate(unrelated, [listing])).toBeUndefined();
    const manual = await loadManganatoIdentity(
      {
        title: "Dorei wo Choukyoushite Harem Tsukuru",
        providers: [{ provider: "anilist", externalId: "149329" }],
      },
      () => {},
    );
    expect(
      selectManganatoCandidate({ ...manual, authors: ["aldehyde"] }, [
        { ...listing, title: manual.titles[0]!, authors: ["aldehyde"] },
      ]),
    ).toBeUndefined();
  });

  it.each([
    [
      "208491",
      "Ore no Ichizu wo Jama Suru Aitsu",
      "Ore no Ichizu o Jama Suru Aitsu",
      "ore-no-ichizu-wo-jama-suru-aitsu",
      "ore-no-ichizu-o-jama-suru-aitsu",
    ],
    [
      "157391",
      "Dark Summoner to Dekiteiru",
      "I'm Dating a Dark Summoner",
      "dark-summoner-to-dekiteiru",
      "i-m-dating-a-dark-summoner",
    ],
    [
      "212891",
      "Himegoto Kakushigoto",
      "Secret Affairs, Hidden Truths",
      "himegoto-kakushigoto",
      "secret-affairs-hidden-truths",
    ],
    [
      "210954",
      "Mada Kimi wo Miageteru",
      "I'm Still Looking Up At You",
      "mada-kimi-o-miageteru",
      "im-still-looking-up-at-you",
    ],
  ])(
    "ranks reviewed duplicates for AniList %s without extending confirmation to unknown slugs",
    async (id, title, alternate, first, second) => {
      const reviewed = await loadManganatoIdentity(
        { title, providers: [{ provider: "anilist", externalId: id }] },
        () => {},
      );
      const smaller = {
        id: first,
        title,
        aliases: [],
        authors: [],
        coverage: { unit: "chapters" as const, count: 2, numbers: [1, 2] },
      };
      const larger = {
        id: second,
        title: alternate,
        aliases: [],
        authors: [],
        coverage: { unit: "chapters" as const, count: 3, numbers: [1, 2, 3] },
      };
      expect(selectManganatoCandidate(reviewed, [smaller, larger])?.id).toBe(second);
      expect(selectManganatoCandidate(reviewed, [larger, smaller])?.id).toBe(second);
      expect(
        selectManganatoCandidate(reviewed, [smaller, larger, { ...larger, id: "unknown" }]),
      ).toBeUndefined();
    },
  );

  it.each([
    ["153502", "Konsei wa Goen ga Arimasu you ni!", "Quinpath Romance", "quinpath-romance"],
    ["130872", "Fuzoroi no Renri", "Fuzoroi no Renri", "fuzoroi-no-renri"],
  ])(
    "honors the explicit listing choice for AniList %s without falling back",
    async (id, title, listingTitle, preferredId) => {
      const reviewed = await loadManganatoIdentity(
        { title, providers: [{ provider: "anilist", externalId: id }] },
        () => {},
      );
      const preferred = {
        id: preferredId,
        title: listingTitle,
        aliases: [],
        authors: [],
        coverage: { unit: "chapters" as const, count: 2, numbers: [1, 2] },
      };
      const other = {
        ...preferred,
        id: "other",
        authors: ["A Creator"],
        coverage: {
          unit: "chapters" as const,
          count: 4,
          numbers: [1, 2, 3, 4],
          latestChapterUpdatedAt: Date.parse("2026-10-01T00:00:00Z"),
        },
      };
      const withAuthors = { ...reviewed, authors: ["A Creator"] };
      for (const candidates of [
        [other, preferred],
        [preferred, other],
        [preferred, { ...other, authors: [] }],
      ]) {
        expect(selectManganatoCandidate(withAuthors, candidates)?.id).toBe(preferredId);
      }
      expect(selectManganatoCandidate(withAuthors, [other])).toBeUndefined();
      expect(
        selectManganatoCandidate(withAuthors, [{ ...preferred, title: "Different work" }, other]),
      ).toBeUndefined();
      expect(
        selectManganatoCandidate(withAuthors, [{ ...preferred, id: "wrong-id" }, other]),
      ).toBeUndefined();
      expect(
        selectManganatoCandidate({ ...withAuthors, manualReview: true }, [preferred]),
      ).toBeUndefined();
      const unrelated = await loadManganatoIdentity(
        { title: listingTitle, providers: [{ provider: "anilist", externalId: "999" }] },
        () => {},
      );
      expect(selectManganatoCandidate(unrelated, [preferred])).toBeUndefined();
    },
  );

  it("uses chapter-update recency only for identical complete leading inventories", () => {
    const listing = (id: string, numbers: readonly number[], latestChapterUpdatedAt?: number) => ({
      ...candidate,
      id,
      coverage: {
        unit: "chapters" as const,
        count: numbers.length,
        numbers,
        latestChapterUpdatedAt,
      },
    });
    const older = listing("older", [1, 2, 3], Date.parse("2025-06-05T03:00:25Z"));
    const newer = listing("newer", [3, 1, 2], Date.parse("2025-06-06T11:14:48Z"));
    const smaller = listing("smaller", [1, 2], Date.parse("2026-08-12T15:37:18Z"));
    for (const pool of [
      [older, smaller, newer],
      [newer, smaller, older],
    ]) {
      expect(selectManganatoCandidate(identity, pool)?.id).toBe("newer");
    }
    expect(selectManganatoCandidate(identity, [older, smaller])?.id).toBe("older");
    for (const other of [
      listing("missing-date", [1, 2, 3]),
      listing("same-date", [1, 2, 3], older.coverage.latestChapterUpdatedAt),
      listing("invalid-date", [1, 2, 3], NaN),
      listing("different-set", [2, 3, 4], newer.coverage.latestChapterUpdatedAt),
      listing("larger-with-gap", [2, 3, 4, 5], newer.coverage.latestChapterUpdatedAt),
    ]) {
      expect(selectManganatoCandidate(identity, [older, other])).toBeUndefined();
    }
  });

  it("preserves chapter updated_at through cached inventories without using fetch time as recency", async () => {
    const inventory = (dates: readonly (string | null | undefined)[]) => ({
      status: 200,
      challenged: false,
      data: {
        success: true,
        data: {
          chapters: dates.map((date, index) => ({
            chapter_slug: `chapter-${index + 1}`,
            chapter_num: index + 1,
            ...(date !== undefined && { updated_at: date }),
          })),
          pagination: { offset: 0, limit: 9000, total: dates.length, has_more: false },
        },
      },
    });
    const catalog: JsonObject[] = [];
    const response = inventory(["2025-06-06T11:14:48.000000Z", "2025-06-05T03:00:25.000000Z"]);
    const coverage = await clientFor([response], 5, {
      onCache: (record) => catalog.push(record),
    }).coverage("pseudo");
    expect(coverage).toMatchObject({
      count: 2,
      latestChapterUpdatedAt: Date.parse("2025-06-06T11:14:48Z"),
    });
    expect(await clientFor([], 5, { catalog }).coverage("pseudo")).toEqual(coverage);
    const oldCatalog = catalog.map((record) => ({ ...record, version: 1 }));
    expect(
      await clientFor([inventory(["2025-06-07T00:00:00Z"])], 5, { catalog: oldCatalog }).coverage(
        "pseudo",
      ),
    ).toMatchObject({ count: 1, latestChapterUpdatedAt: Date.parse("2025-06-07T00:00:00Z") });
    expect(await clientFor([inventory(["2024-02-29T00:00:00Z"])]).coverage("pseudo")).toMatchObject(
      { latestChapterUpdatedAt: Date.parse("2024-02-29T00:00:00Z") },
    );
    for (const date of [
      undefined,
      null,
      "not a date",
      "2025-06-06",
      "2025-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2099-01-01T00:00:00Z",
    ]) {
      expect(
        (await clientFor([inventory(["2025-06-06T11:14:48Z", date])]).coverage("pseudo"))
          .latestChapterUpdatedAt,
      ).toBeUndefined();
    }
  });

  it("counts distinct positions across complete inventories, not uploads or highest chapter numbers", async () => {
    const inventory = (
      offset: number,
      hasMore: boolean,
      chapters: { chapter_slug: string; chapter_num: number | null }[],
    ) => ({
      status: 200,
      challenged: false,
      data: {
        success: true,
        data: {
          chapters,
          pagination: { offset, limit: 3, total: 4, has_more: hasMore },
        },
      },
    });
    const catalog: JsonObject[] = [];
    const first = inventory(0, true, [
      { chapter_slug: "chapter-1", chapter_num: 1 },
      { chapter_slug: "chapter-1-other-upload", chapter_num: 1 },
      { chapter_slug: "chapter-1.5", chapter_num: 1.5 },
    ]);
    const last = inventory(3, false, [{ chapter_slug: "chapter-5000", chapter_num: 5000 }]);
    const expected = { unit: "chapters", count: 3, numbers: [1, 1.5, 5000] };
    expect(
      await clientFor([first, last], 5, { onCache: (record) => catalog.push(record) }).coverage(
        "pseudo",
      ),
    ).toMatchObject(expected);
    expect(await clientFor([], 5, { catalog }).coverage("pseudo")).toMatchObject(expected);
    await expect(clientFor([], 1, { catalog }).coverage("pseudo")).rejects.toThrow(/exceeded/);
    await expect(
      clientFor([
        first,
        inventory(3, false, [{ chapter_slug: "chapter-1", chapter_num: 1 }]),
      ]).coverage("pseudo"),
    ).rejects.toThrow(/repeated/);
    await expect(clientFor([inventory(3, false, [])]).coverage("pseudo")).rejects.toThrow(
      /inconsistent/,
    );
    const unknown = inventory(0, false, [{ chapter_slug: "extra", chapter_num: null }]);
    unknown.data.data.pagination.total = 1;
    expect((await clientFor([unknown]).coverage("pseudo")).unit).toBe("unknown");
    const invalid = { ...catalog[0]!, id: "other" };
    await expect(clientFor([], 5, { catalog: [invalid] }).coverage("pseudo")).rejects.toThrow(
      /Unexpected/,
    );
  });

  it("counts same-page duplicates once, excludes negatives in either order, and paginates by raw records", async () => {
    const records = [
      { chapter_slug: "chapter-1", chapter_num: -1 },
      { chapter_slug: "chapter-1", chapter_num: "1" },
      { chapter_slug: "chapter-1", chapter_num: 1 },
      { chapter_slug: "chapter-58-3", chapter_num: 58.300000000000004 },
      { chapter_slug: "chapter-58-3", chapter_num: "58.3" },
      { chapter_slug: "chapter-58-31", chapter_num: 58.31 },
    ];
    const response = (chapters: typeof records, offset: number, hasMore: boolean) => ({
      status: 200,
      challenged: false,
      data: {
        success: true,
        data: {
          chapters,
          pagination: { total: 7, limit: 6, offset, has_more: hasMore },
        },
      },
    });
    for (const first of [records, [...records].reverse()]) {
      const catalog: JsonObject[] = [];
      const coverage = await clientFor(
        [
          response(first, 0, true),
          response([{ chapter_slug: "chapter-2", chapter_num: 2 }], 6, false),
        ],
        5,
        { onCache: (record) => catalog.push(record) },
      ).coverage("pseudo");
      expect(coverage).toEqual({
        unit: "chapters",
        count: 4,
        numbers: [1, 2, 58.3, 58.31],
        inventory: {
          rawRecords: 7,
          duplicateRecords: 2,
          excludedNegativeRecords: 1,
          normalizedRecords: 1,
        },
      });
      expect(await clientFor([], 5, { catalog }).coverage("pseudo")).toEqual(coverage);
    }
  });

  it("retains real fractional positions and unknown metadata while rejecting conflicting IDs and page overlaps", async () => {
    const response = (
      chapters: { chapter_slug: string; chapter_num: number | string | null }[],
      offset = 0,
      total = chapters.length,
    ) => ({
      status: 200,
      challenged: false,
      data: {
        success: true,
        data: {
          chapters,
          pagination: { total, limit: 9000, offset, has_more: offset + chapters.length < total },
        },
      },
    });
    const coverage = await clientFor([
      response([
        { chapter_slug: "zero", chapter_num: 0 },
        { chapter_slug: "part-a", chapter_num: 58.1 },
        { chapter_slug: "part-b", chapter_num: "58.2" },
        { chapter_slug: "precise", chapter_num: 58.300000001 },
        { chapter_slug: "tiny", chapter_num: 0.000000000001 },
      ]),
    ]).coverage("pseudo");
    expect(coverage.numbers).toEqual([0, 0.000000000001, 58.1, 58.2, 58.300000001]);
    for (const number of [null, "", "Special", "-Special", "NaN", "0x10", "1e2"]) {
      expect(
        (
          await clientFor([response([{ chapter_slug: "extra", chapter_num: number }])]).coverage(
            "pseudo",
          )
        ).unit,
      ).toBe("unknown");
    }
    expect(
      await clientFor([response([{ chapter_slug: "negative", chapter_num: "-1.5" }])]).coverage(
        "pseudo",
      ),
    ).toMatchObject({
      unit: "chapters",
      count: 0,
      inventory: { excludedNegativeRecords: 1 },
    });
    expect(
      await clientFor([
        response([{ chapter_slug: "negative", chapter_num: -1 }], 0, 2),
        response([{ chapter_slug: "positive", chapter_num: 2 }], 1, 2),
      ]).coverage("pseudo"),
    ).toMatchObject({
      unit: "chapters",
      numbers: [2],
      inventory: { rawRecords: 2, excludedNegativeRecords: 1 },
    });
    expect(
      (
        await clientFor([
          response([
            { chapter_slug: "same", chapter_num: -1 },
            { chapter_slug: "same", chapter_num: null },
          ]),
        ]).coverage("pseudo")
      ).unit,
    ).toBe("unknown");
    expect(await clientFor([response([])]).coverage("pseudo")).toMatchObject({
      unit: "chapters",
      count: 0,
    });
    await expect(clientFor([response([], 0, 1)]).coverage("pseudo")).rejects.toThrow(
      /inconsistent/,
    );
    for (const numbers of [
      [1, 2],
      [1, null],
      [null, null],
      ["Special", "Special"],
    ]) {
      await expect(
        clientFor([
          response(numbers.map((chapter_num) => ({ chapter_slug: "same", chapter_num }))),
        ]).coverage("pseudo"),
      ).rejects.toThrow(/conflicting/);
    }
    await expect(
      clientFor([
        response([{ chapter_slug: "same", chapter_num: 1 }], 0, 2),
        response([{ chapter_slug: "same", chapter_num: 1 }], 1, 2),
      ]).coverage("pseudo"),
    ).rejects.toThrow(/repeated.*across pages/);
    for (const later of [1, -1]) {
      await expect(
        clientFor([
          response([{ chapter_slug: "same", chapter_num: -1 }], 0, 2),
          response([{ chapter_slug: "same", chapter_num: later }], 1, 2),
        ]).coverage("pseudo"),
      ).rejects.toThrow(/repeated.*across pages/);
    }
  });

  it("returns competitors from later pages rather than selecting the first hit", async () => {
    const client = clientFor([page(["one"], "/search/story/pseudo?page=2"), page(["one", "two"])]);
    expect((await client.search("pseudo")).map((hit) => hit.id)).toEqual(["one", "two"]);
    expect((await client.search("pseudo")).map((hit) => hit.id)).toEqual(["one", "two"]);
  });

  it.each([
    ["Akiba's Trip 2", "akiba%27s_trip_2"],
    ["Oto Shite Kudasai! Megami-sama!!", "oto_shite_kudasai%21_megami-sama%21%21"],
    ["Girls × Vampire (Pre-serialization)", "girls_%c3%97_vampire_%28pre-serialization%29"],
    ["Kensei Shita.", "kensei_shita"],
  ])(
    "accepts provider-encoded full-title pagination and resumes its cached first page: %s",
    async (query, encoded) => {
      const catalog: JsonObject[] = [];
      const firstPage = page(["one"], `https://www.manganato.gg/search/story/${encoded}?page=2`);
      await expect(
        clientFor([firstPage], 1, { onCache: (record) => catalog.push(record) }).search(query),
      ).rejects.toBeInstanceOf(ManganatoPageBudgetError);
      expect(catalog).toHaveLength(1);
      expect(
        (await clientFor([page(["two"])], 2, { catalog }).search(query)).map((hit) => hit.id),
      ).toEqual(["one", "two"]);
    },
  );

  it("rejects incomplete, repeated, off-site and nonadvancing pagination", async () => {
    for (const next of [
      "/search/story/pseudo?page=1",
      "https://evil.test/search/story/pseudo?page=2",
      "/search/story/changed?page=2",
      "/search/story/pseudo?page=NaN",
      "/search/story/pseudo?page=3",
      "/search/story/pseudo?page=02",
      "/search/story/pseudo?page=2&page=2",
      "/search/story/pseudo?page=2&extra=1",
      "/search/story/pseudo?page=2#",
      "/search/story/pseudo?page=2#fragment",
      "/search/story/pseudo/?page=2",
      "/search/story/pseudo/extra?page=2",
      "/search/story/%2570seudo?page=2",
      "/search/story/%broken?page=2",
      "https://user:password@www.manganato.gg/search/story/pseudo?page=2",
    ]) {
      const catalog: JsonObject[] = [];
      await expect(
        clientFor([page(["one"], next)], 5, { onCache: (record) => catalog.push(record) }).search(
          "pseudo",
        ),
      ).rejects.toThrow(/pagination/);
      expect(catalog).toEqual([]);
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

  it.each([
    { status: 200, challenged: true, data: null },
    { status: 403, challenged: false, data: null },
    { status: 429, challenged: false, data: null },
    { status: 0, challenged: false, timedOut: true, data: null },
    new Error("TimeoutError: operation timed out"),
  ])(
    "holds the current page until human recovery, without restarting prior pages: %s",
    async (blocked) => {
      const catalog: JsonObject[] = [];
      const waits: string[] = [];
      const client = clientFor(
        [page(["one"], "/search/story/pseudo?page=2"), blocked, blocked, page(["two"])],
        5,
        {
          onCache: (record) => catalog.push(record),
          onBlocked: async (error) => {
            waits.push(error.message);
            // Completed reads are saved, but no blocked page is cached as an empty result.
            expect(catalog).toHaveLength(1);
            await Promise.resolve();
          },
        },
      );
      expect((await client.search("pseudo")).map((hit) => hit.id)).toEqual(["one", "two"]);
      expect(waits).toHaveLength(2);
      expect(waits.every((message) => message.includes("page=2"))).toBe(true);
      expect(catalog).toHaveLength(2);
    },
  );

  it("stops on a transport timeout without a recovery handler, but preserves ordinary errors", async () => {
    await expect(
      clientFor([new Error("Timeout after 30000ms")]).search("pseudo"),
    ).rejects.toBeInstanceOf(ManganatoBlockedError);
    const error = new Error("Invalid browser script");
    const onBlocked = vi.fn();
    await expect(clientFor([error], 5, { onBlocked }).search("pseudo")).rejects.toBe(error);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it.each([
    { status: 200, headers: { "cf-mitigated": "challenge" } },
    { status: 403, headers: {} },
    { status: 429, headers: {} },
  ])(
    "recognizes restricted response headers before reading a potentially stalled body: %s",
    async (response) => {
      const client = clientFor([], 5, {
        execute: (script) =>
          runInNewContext(script, {
            location: { origin: "https://www.manganato.gg" },
            AbortSignal,
            fetch: async () => ({
              ...response,
              headers: new Headers(response.headers),
              text: async () => {
                throw new Error("Must not read a restriction body");
              },
            }),
          }),
      });
      await expect(client.coverage("target")).rejects.toBeInstanceOf(ManganatoBlockedError);
    },
  );

  it.each(["fetch", "body"])(
    "preserves a browser %s timeout as a recoverable timeout",
    async (stage) => {
      const client = clientFor([], 5, {
        execute: (script) =>
          runInNewContext(script, {
            location: { origin: "https://www.manganato.gg" },
            AbortSignal: { timeout: () => AbortSignal.abort() },
            fetch: async () => {
              if (stage === "fetch") throw new Error("Aborted");
              return {
                status: 200,
                headers: new Headers(),
                text: async () => {
                  throw new Error("Aborted");
                },
              };
            },
          }),
      });
      await expect(client.coverage("target")).rejects.toMatchObject({
        reason: "timeout",
        message: expect.stringContaining("request timed out"),
      });
    },
  );
});
