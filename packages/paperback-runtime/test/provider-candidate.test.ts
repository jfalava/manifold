/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { describe, expect, it } from "vitest";
import {
  canonicalProviderCandidate,
  correlateProviderCandidates,
  parseProviderCandidateId,
  parseProviderSearchInput,
  providerCandidateId,
  toProviderCandidateSearchResult,
} from "../src/provider-candidate";

describe("provider candidates", () => {
  it("creates MAL candidates without relabeling their IDs as AniList", () => {
    const candidate = canonicalProviderCandidate({
      id: "mal:77",
      provider: "mal",
      providerId: "77",
      title: "Example",
      aliases: ["Alias"],
      externalIds: { mal: "77" },
      metadata: { coverUrl: "https://example.test/mal.jpg" },
    });
    expect(candidate).toMatchObject({ provider: "mal", providerId: "77", links: [] });
    expect(toProviderCandidateSearchResult(candidate)).toMatchObject({
      mangaId: "provider-candidate:mal:77",
      subtitle: "MyAnimeList · Alias",
    });
    expect(parseProviderSearchInput("mal: Example")).toEqual({ query: "Example", scope: "mal" });
  });

  it("carries proven MAL cross-links even when a candidate is reopened without a search cache", () => {
    expect(
      canonicalProviderCandidate({
        id: "anilist:42",
        provider: "anilist",
        providerId: "42",
        title: "Example",
        aliases: [],
        externalIds: { anilist: "42", mal: "77" },
      }).links,
    ).toEqual([{ provider: "mal", externalId: "77" }]);
  });

  it("correlates MAL through MangaDex and preserves its proven AniList link", () => {
    const result = correlateProviderCandidates([
      { provider: "mal", providerId: "77", title: "Example", aliases: [], imageUrl: "" },
      {
        provider: "anilist",
        providerId: "77",
        title: "Different manga",
        aliases: [],
        imageUrl: "",
      },
      {
        provider: "mangadex",
        providerId: "md-1",
        title: "Other language",
        aliases: [],
        imageUrl: "",
        links: [
          { provider: "mal", externalId: "77" },
          { provider: "anilist", externalId: "42" },
        ],
      },
    ]);
    expect(result[0]?.links).toEqual([
      { provider: "mangadex", externalId: "md-1", title: "Other language" },
      { provider: "anilist", externalId: "42" },
    ]);
    expect(result[1]?.links).toBeUndefined();
  });

  it("rejects contradictory cross-links during correlation", () => {
    const result = correlateProviderCandidates([
      {
        provider: "mal",
        providerId: "77",
        title: "Example",
        aliases: [],
        imageUrl: "",
        links: [{ provider: "anilist", externalId: "99" }],
      },
      {
        provider: "mangadex",
        providerId: "md-1",
        title: "Example",
        aliases: [],
        imageUrl: "",
        links: [
          { provider: "mal", externalId: "77" },
          { provider: "anilist", externalId: "42" },
        ],
      },
    ]);
    expect(result[0]?.links).toEqual([{ provider: "anilist", externalId: "99" }]);
  });

  it("round-trips provider ids without confusing them with registry UUIDs", () => {
    const id = providerCandidateId("comix", "abc/title:one");
    expect(parseProviderCandidateId(id)).toEqual({
      provider: "comix",
      providerId: "abc/title:one",
    });
    expect(parseProviderCandidateId("11111111-1111-1111-1111-111111111111")).toBeUndefined();
  });

  it("labels provider search results", () => {
    expect(
      toProviderCandidateSearchResult({
        provider: "mangadex",
        providerId: "md-1",
        title: "Example",
        aliases: ["Alias"],
        imageUrl: "https://example.test/cover.jpg",
      }),
    ).toMatchObject({
      mangaId: "provider-candidate:mangadex:md-1",
      title: "Example",
      subtitle: "MangaDex · Alias",
    });
  });

  it("recognizes provider-scoped search prefixes", () => {
    expect(parseProviderSearchInput("md: One Piece")).toEqual({
      query: "One Piece",
      scope: "mangadex",
    });
    expect(parseProviderSearchInput("comix:Villainess")).toEqual({
      query: "Villainess",
      scope: "comix",
    });
    expect(parseProviderSearchInput("Title: Subtitle")).toEqual({
      query: "Title: Subtitle",
      scope: "all",
    });
  });

  it("correlates AniList and MangaDex only through MangaDex's exact cross-link", () => {
    const candidates = correlateProviderCandidates([
      { provider: "anilist", providerId: "42", title: "Example", aliases: [], imageUrl: "" },
      {
        provider: "mangadex",
        providerId: "md-1",
        title: "Example",
        aliases: [],
        imageUrl: "",
        links: [{ provider: "anilist", externalId: "42" }],
      },
    ]);
    expect(candidates[0]?.links).toContainEqual({
      provider: "mangadex",
      externalId: "md-1",
      title: "Example",
    });
  });

  it("does not correlate candidates from matching titles alone", () => {
    const candidates = correlateProviderCandidates([
      { provider: "anilist", providerId: "42", title: "Example", aliases: [], imageUrl: "" },
      { provider: "mangadex", providerId: "md-1", title: "Example", aliases: [], imageUrl: "" },
    ]);
    expect(candidates[0]?.links).toBeUndefined();
  });

  it("does not choose between ambiguous MangaDex cross-links", () => {
    const candidates = correlateProviderCandidates([
      { provider: "anilist", providerId: "42", title: "Example", aliases: [], imageUrl: "" },
      {
        provider: "mangadex",
        providerId: "md-1",
        title: "Example A",
        aliases: [],
        imageUrl: "",
        links: [{ provider: "anilist", externalId: "42" }],
      },
      {
        provider: "mangadex",
        providerId: "md-2",
        title: "Example B",
        aliases: [],
        imageUrl: "",
        links: [{ provider: "anilist", externalId: "42" }],
      },
    ]);
    expect(candidates[0]?.links).toBeUndefined();
  });
});
