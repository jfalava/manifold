import { describe, expect, it } from "vitest";

import type { AniListRichEntry } from "../src/anilist";
import {
  buildEntitiesForEntry,
  hasUpstreamProvider,
  matchingBaseLibraryIds,
  migrateLibrarySources,
  sourceFreeEntities,
} from "../src/commands/al2pas5";
import type { RegistryRow } from "../src/commands/toolbox";
import type { Pas5Entities } from "../src/pas5";

const entry: AniListRichEntry = {
  mediaId: 123,
  status: "CURRENT",
  title: "Example Manga",
  romajiTitle: "Example Manga Romaji",
  nativeTitle: "例",
  synonyms: [],
  mediaStatus: "RELEASING",
};

const registryRow: RegistryRow = {
  id: "canonical-id",
  provider: "anilist",
  providerId: "123",
  title: entry.title,
  createdAt: 1,
  updatedAt: 1,
  providers: [
    { provider: "anilist", externalId: "123", updatedAt: 1 },
    { provider: "mangadex", externalId: "mangadex-id", updatedAt: 1 },
    { provider: "comix", externalId: "comix-id", updatedAt: 1 },
  ],
};

const entitiesFrom = (
  generated: ReturnType<typeof buildEntitiesForEntry>,
): Pas5Entities => ({
  __LIBRARY_MANGA_V5: { [generated.library.id]: generated.library },
  __SOURCE_MANGA_V5: Object.fromEntries(
    generated.sources.map((source) => [source.id, source]),
  ),
  __MANGA_INFO_V5: generated.infos,
});

describe("al2pas5 source attachments", () => {
  it("adds every proven upstream provider to new library entries", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());

    expect(generated.sources.map(({ sourceId, mangaId }) => ({ sourceId, mangaId })))
      .toEqual([
        { sourceId: "MangaDex", mangaId: "mangadex-id" },
        { sourceId: "Comix", mangaId: "comix-id" },
        { sourceId: "ManifoldTracker", mangaId: "canonical-id" },
      ]);
    expect(generated.library.attachedSources.map((source) => source.id))
      .toEqual(generated.sources.map((source) => source.id));
    expect(Object.keys(generated.infos)).toHaveLength(3);
  });

  it("enriches an existing entry without duplicating its library row", () => {
    const originalRow: RegistryRow = {
      ...registryRow,
      providers: registryRow.providers.filter(
        (provider) => provider.provider === "anilist",
      ),
    };
    const original = entitiesFrom(
      buildEntitiesForEntry(entry, originalRow, new Map()),
    );
    const matches = matchingBaseLibraryIds(original, entry, registryRow);

    expect(matches).toEqual([Object.keys(original.__LIBRARY_MANGA_V5)[0]]);
    const result = migrateLibrarySources(
      original,
      matches[0]!,
      entry,
      registryRow,
    );
    expect(result.sources.map(({ sourceId, mangaId }) => ({ sourceId, mangaId })))
      .toEqual([
        { sourceId: "MangaDex", mangaId: "mangadex-id" },
        { sourceId: "Comix", mangaId: "comix-id" },
      ]);
    expect(result.library.attachedSources).toHaveLength(3);
    expect(result.conflicts).toBe(0);

    const enriched: Pas5Entities = {
      __LIBRARY_MANGA_V5: { [matches[0]!]: result.library },
      __SOURCE_MANGA_V5: {
        ...original.__SOURCE_MANGA_V5,
        ...Object.fromEntries(result.sources.map((source) => [source.id, source])),
      },
      __MANGA_INFO_V5: {
        ...original.__MANGA_INFO_V5,
        ...result.infos,
      },
    };
    expect(
      migrateLibrarySources(enriched, matches[0]!, entry, registryRow).sources,
    ).toHaveLength(0);
  });

  it("does not replace a conflicting provider attachment", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());
    const base = entitiesFrom(generated);
    const mangaDex = generated.sources.find((source) => source.sourceId === "MangaDex")!;
    base.__SOURCE_MANGA_V5[mangaDex.id] = {
      ...mangaDex,
      mangaId: "different-mangadex-id",
    };

    const result = migrateLibrarySources(
      base,
      generated.library.id,
      entry,
      registryRow,
    );
    expect(result.sources).toHaveLength(0);
    expect(result.conflicts).toBe(1);
  });

  it("removes ManifoldSource and drops tracker-only libraries", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());
    const base = entitiesFrom(generated);
    const legacyInfoId = "ManifoldSource:canonical-id";
    const legacySource = {
      ...generated.sources[0]!,
      id: "legacy-source",
      sourceId: "ManifoldSource",
      mangaId: registryRow.id,
      mangaInfo: { id: legacyInfoId, type: "__MANGA_INFO_V5" as const },
    };
    base.__SOURCE_MANGA_V5[legacySource.id] = legacySource;
    base.__MANGA_INFO_V5[legacyInfoId] = generated.infos[
      String(generated.sources[0]!.mangaInfo.id)
    ]!;
    base.__LIBRARY_MANGA_V5[generated.library.id] = {
      ...generated.library,
      attachedSources: [
        { id: legacySource.id, type: "__SOURCE_MANGA_V5" },
        ...generated.library.attachedSources,
      ],
    };

    const cleaned = sourceFreeEntities(base, {
      __LIBRARY_MANGA_V5: {},
      __SOURCE_MANGA_V5: {},
      __MANGA_INFO_V5: {},
    });

    expect(cleaned.removedLegacySources).toBe(1);
    expect(cleaned.removedProviderlessLibraries).toBe(0);
    expect(Object.values(cleaned.entities.__SOURCE_MANGA_V5))
      .not.toContainEqual(expect.objectContaining({ sourceId: "ManifoldSource" }));

    const trackerOnly = entitiesFrom(buildEntitiesForEntry(entry, {
      ...registryRow,
      providers: registryRow.providers.filter((provider) => provider.provider === "anilist"),
    }, new Map()));
    const pruned = sourceFreeEntities(undefined, trackerOnly);
    expect(pruned.removedProviderlessLibraries).toBe(1);
    expect(pruned.entities.__LIBRARY_MANGA_V5).toEqual({});
    expect(pruned.entities.__SOURCE_MANGA_V5).toEqual({});
  });

  it("requires a proven native content provider", () => {
    expect(hasUpstreamProvider(registryRow)).toBe(true);
    expect(hasUpstreamProvider({
      ...registryRow,
      providers: registryRow.providers.filter((provider) => provider.provider === "anilist"),
    })).toBe(false);
    expect(hasUpstreamProvider(undefined)).toBe(false);
  });

  it("does not match unrelated base metadata when the registry is unresolved", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());
    const base = entitiesFrom(generated);
    const unrelated: AniListRichEntry = {
      ...entry,
      mediaId: 999,
      title: "Unrelated Manga",
    };

    expect(matchingBaseLibraryIds(base, unrelated, undefined)).toEqual([]);
  });
});
