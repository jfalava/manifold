import { describe, expect, it, vi } from "vitest";

vi.mock("@/anilist", () => ({
  fetchAniListTitles: async () => [
    "My Neighbor Furi-san is Scary",
    "Tonari no Uchuubito ga Kowai",
    "Tonari no Furi-san ga Tonikaku Kowai",
  ],
}));

import { loadRegistrySearchTitles, providerIdOf, searchTitlesFor } from "../src/comix-aliases";

describe("registry search aliases", () => {
  it("reads anilist and mangadex ids from the registry row", () => {
    const row = {
      title: "Tonari no Uchuubito ga Kowai",
      providers: [
        { provider: "anilist", externalId: "123" },
        { provider: "mangadex", externalId: "md-1" },
      ],
    };
    expect(providerIdOf(row, "anilist")).toBe("123");
    expect(providerIdOf(row, "comix")).toBeUndefined();
  });

  it("keeps the first three unique titles for Comix browse", () => {
    expect(
      searchTitlesFor([
        "Tonari no Uchuubito ga Kowai",
        "My Neighbor Furi-san is Scary",
        "Tonari no Furi-san ga Tonikaku Kowai",
        "Extra synonym",
      ]),
    ).toEqual([
      "Tonari no Uchuubito ga Kowai",
      "My Neighbor Furi-san is Scary",
      "Tonari no Furi-san ga Tonikaku Kowai",
    ]);
  });

  it("uses AniList english/romaji/synonyms before MangaDex", async () => {
    const titles = await loadRegistrySearchTitles(
      {
        title: "Tonari no Uchuubito ga Kowai",
        providers: [{ provider: "anilist", externalId: "123" }],
      },
      { anilistToken: "token" },
    );
    expect(titles).toEqual([
      "Tonari no Uchuubito ga Kowai",
      "My Neighbor Furi-san is Scary",
      "Tonari no Furi-san ga Tonikaku Kowai",
    ]);
  });

  it("falls back to MangaDex alt titles when AniList is missing", async () => {
    const titles = await loadRegistrySearchTitles(
      {
        title: "Tonari no Uchuubito ga Kowai",
        providers: [{ provider: "mangadex", externalId: "md-1" }],
      },
      {
        mangaDexTitles: async (id) => {
          expect(id).toBe("md-1");
          return ["My Neighbor Furi-san is Scary", "Tonari no Furi-san ga Tonikaku Kowai"];
        },
      },
    );
    expect(titles).toContain("My Neighbor Furi-san is Scary");
  });
});
