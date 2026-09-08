import { describe, expect, it } from "vitest";

import type { CanonicalSearchResult } from "@manifold/canonical";
import {
  filterAndRankAniListResults,
  filterAndRankRegistryEntries,
} from "../src/MANIFOLD/search-relevance";

const aniListResult = (
  id: string,
  title: string,
  aliases: readonly string[] = [],
): CanonicalSearchResult => ({
  id: `anilist:${id}`,
  provider: "anilist",
  providerId: id,
  title,
  aliases: [title, ...aliases],
  score: 0,
});

describe("tracker search relevance", () => {
  it("keeps only tight AniList title/alias matches and ranks exact matches first", () => {
    const results = filterAndRankAniListResults("Blue Box", [
      aniListResult("1", "Blue Box: A Collection"),
      aniListResult("2", "Unrelated title"),
      aniListResult("3", "Blue Box", ["Ao no Hako"]),
    ]);

    expect(results.map((result) => result.providerId)).toEqual(["3", "1"]);
  });

  it("ranks exact registry titles before broader provider-title matches", () => {
    const entries = [
      {
        id: "b",
        provider: "anilist" as const,
        providerId: "2",
        title: "Blue Box Special",
        createdAt: 1,
        updatedAt: 1,
        providers: [],
      },
      {
        id: "a",
        provider: "anilist" as const,
        providerId: "1",
        title: "Different registry title",
        createdAt: 1,
        updatedAt: 1,
        providers: [{ provider: "anilist" as const, externalId: "1", title: "Blue Box", updatedAt: 1 }],
      },
    ];

    expect(filterAndRankRegistryEntries("Blue Box", entries).map((entry) => entry.id))
      .toEqual(["a", "b"]);
  });
});
