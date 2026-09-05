import { describe, expect, it } from "vitest";
import {
  correlateProviderCandidates,
  parseProviderCandidateId,
  parseProviderSearchInput,
  providerCandidateId,
  toProviderCandidateSearchResult,
} from "../src/provider-candidate";

describe("provider candidates", () => {
  it("round-trips provider ids without confusing them with registry UUIDs", () => {
    const id = providerCandidateId("comix", "abc/title:one");
    expect(parseProviderCandidateId(id)).toEqual({
      provider: "comix",
      providerId: "abc/title:one",
    });
    expect(parseProviderCandidateId("11111111-1111-1111-1111-111111111111")).toBeUndefined();
  });

  it("labels provider search results", () => {
    expect(toProviderCandidateSearchResult({
      provider: "mangadex",
      providerId: "md-1",
      title: "Example",
      aliases: ["Alias"],
      imageUrl: "https://example.test/cover.jpg",
    })).toMatchObject({
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
