/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { describe, expect, it } from "vitest";

import { loadRegistrySearchTitles, providerIdOf, searchTitlesFor } from "../src/comix-aliases";

const anilistFixtureTitles = async (): Promise<readonly string[]> => [
  "My Neighbor Furi-san is Scary",
  "Tonari no Uchuubito ga Kowai",
  "Tonari no Furi-san ga Tonikaku Kowai",
];

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
      { anilistToken: "token", anilistTitles: anilistFixtureTitles },
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
