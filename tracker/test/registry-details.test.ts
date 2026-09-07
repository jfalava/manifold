import { describe, expect, it } from "vitest";

import { canonicalResultForRegistryEntry } from "../src/ManifoldTracker/registry-details";

const registryEntry = {
  id: "d579129d-1ecf-43d0-8eab-4c939e578eed",
  provider: "anilist" as const,
  providerId: "42",
  title: "Registry title",
  providers: [
    { provider: "anilist" as const, externalId: "42", updatedAt: 1 },
  ],
};

describe("registry details", () => {
  it("keeps the registry UUID when AniList supplies display metadata", () => {
    const result = canonicalResultForRegistryEntry(registryEntry, {
      id: "anilist:42",
      provider: "anilist",
      providerId: "42",
      title: "Specific AniList title",
      aliases: ["Specific AniList title", "Alternate title"],
      metadata: {
        coverUrl: "https://example.test/cover.jpg",
        description: "Description",
      },
    });

    expect(result).toEqual({
      id: registryEntry.id,
      provider: "anilist",
      providerId: "42",
      title: "Specific AniList title",
      aliases: ["Specific AniList title", "Alternate title"],
      metadata: {
        coverUrl: "https://example.test/cover.jpg",
        description: "Description",
      },
      score: 0,
    });
  });

  it("falls back to the exact linked provider instead of guessing by title", () => {
    expect(canonicalResultForRegistryEntry(registryEntry, undefined)).toMatchObject({
      id: registryEntry.id,
      provider: "anilist",
      providerId: "42",
      title: "Registry title",
    });
  });
});
