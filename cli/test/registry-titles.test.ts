/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { describe, expect, it, vi } from "vitest";

import { loadRegistrySearchTitles, providerIdOf, searchTitlesFor } from "../src/registry-titles";

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
    expect(providerIdOf(row, "kagane")).toBeUndefined();
  });

  it("keeps the first three unique titles for provider search", () => {
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

  it("cancels stalled alias lookups after 20s and preserves fallback titles", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.signal) {
          throw new Error("Alias fetch must support cancellation");
        }
        signals.push(init.signal);
        return new Promise<Response>(() => {});
      });
      const anilist = loadRegistrySearchTitles(
        {
          title: "Known title",
          providers: [
            { provider: "anilist", externalId: "123" },
            { provider: "mangadex", externalId: "md-1" },
          ],
        },
        {
          anilistToken: "token",
          mangaDexTitles: async () => ["Fallback alias"],
        },
      );
      const mangadex = loadRegistrySearchTitles({
        title: "Other title",
        providers: [{ provider: "mangadex", externalId: "md-2" }],
      });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await anilist).toEqual(["Known title", "Fallback alias"]);
      expect(await mangadex).toEqual(["Other title"]);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
