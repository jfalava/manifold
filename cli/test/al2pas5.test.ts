import { describe, expect, it } from "vitest";

import type { AniListRichEntry } from "../src/anilist";
import {
  buildEntitiesForEntry,
  hasUpstreamProvider,
  matchingBaseLibraryIds,
  migrateLibrarySources,
  sourceFreeEntities,
} from "../src/commands/anilist/create-pas5";
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

const entitiesFrom = (generated: ReturnType<typeof buildEntitiesForEntry>): Pas5Entities => ({
  __LIBRARY_MANGA_V5: { [generated.library.id]: generated.library },
  __SOURCE_MANGA_V5: Object.fromEntries(generated.sources.map((source) => [source.id, source])),
  __MANGA_INFO_V5: generated.infos,
});

describe("al2pas5 source attachments", () => {
  it("adds every proven upstream provider to new library entries", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());

    expect(generated.sources.map(({ sourceId, mangaId }) => ({ sourceId, mangaId }))).toEqual([
      { sourceId: "MangaDex", mangaId: "mangadex-id" },
      { sourceId: "Comix", mangaId: "comix-id" },
      { sourceId: "MANIFOLD", mangaId: "canonical-id" },
    ]);
    expect(generated.library.attachedSources.map((source) => source.id)).toEqual(
      generated.sources.map((source) => source.id),
    );
    expect(Object.keys(generated.infos)).toHaveLength(3);
  });

  it("enriches an existing entry without duplicating its library row", () => {
    const originalRow: RegistryRow = {
      ...registryRow,
      providers: registryRow.providers.filter((provider) => provider.provider === "anilist"),
    };
    const original = entitiesFrom(buildEntitiesForEntry(entry, originalRow, new Map()));
    const matches = matchingBaseLibraryIds(original, entry, registryRow);

    expect(matches).toEqual([Object.keys(original.__LIBRARY_MANGA_V5)[0]]);
    const result = migrateLibrarySources(original, matches[0]!, entry, registryRow);
    expect(result.sources.map(({ sourceId, mangaId }) => ({ sourceId, mangaId }))).toEqual([
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
    expect(migrateLibrarySources(enriched, matches[0]!, entry, registryRow).sources).toHaveLength(
      0,
    );
  });

  it("replaces a stale tracker UUID and prunes its orphaned metadata", () => {
    const generated = buildEntitiesForEntry(
      entry,
      {
        ...registryRow,
        id: "91a074d5-6c22-42cc-9846-3d55a32bfa83",
      },
      new Map(),
    );
    const base = entitiesFrom(generated);
    expect(matchingBaseLibraryIds(base, entry, registryRow)).toEqual([generated.library.id]);
    const result = migrateLibrarySources(base, generated.library.id, entry, registryRow);
    expect(result.conflicts).toBe(0);
    expect(result.sources).toEqual([
      expect.objectContaining({ sourceId: "MANIFOLD", mangaId: registryRow.id }),
    ]);
    const cleaned = sourceFreeEntities(base, {
      __LIBRARY_MANGA_V5: { [generated.library.id]: result.library },
      __SOURCE_MANGA_V5: Object.fromEntries(result.sources.map((source) => [source.id, source])),
      __MANGA_INFO_V5: result.infos,
    }).entities;
    expect(Object.values(cleaned.__SOURCE_MANGA_V5)).toHaveLength(3);
    expect(
      Object.values(cleaned.__SOURCE_MANGA_V5)
        .filter((source) => source.sourceId === "MANIFOLD")
        .map((source) => source.mangaId),
    ).toEqual([registryRow.id]);
    expect(
      Object.values(cleaned.__MANGA_INFO_V5)
        .filter((info) => info.additionalInfo["Canonical ID"])
        .map((info) => info.additionalInfo["Canonical ID"]),
    ).toEqual([registryRow.id]);
    expect(
      migrateLibrarySources(cleaned, generated.library.id, entry, registryRow).sources,
    ).toHaveLength(0);
  });

  it("fills missing tabs without new sources and preserves existing collections", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());
    const base = entitiesFrom(generated);
    const tab = { id: "shared-reading", name: "Reading", sortOrder: 0 };
    const tabs = new Map([[tab.name, tab]]);
    const result = migrateLibrarySources(base, generated.library.id, entry, registryRow, tabs);
    expect(result.sources).toHaveLength(0);
    expect(result.library.libraryTabs).toEqual([tab]);
    expect(
      migrateLibrarySources(base, generated.library.id, entry, registryRow, new Map()).library
        .libraryTabs,
    ).toEqual([]);
    const custom = { id: "custom", name: "Favorites", sortOrder: 5 };
    base.__LIBRARY_MANGA_V5[generated.library.id] = { ...generated.library, libraryTabs: [custom] };
    expect(
      migrateLibrarySources(base, generated.library.id, entry, registryRow, tabs).library
        .libraryTabs,
    ).toEqual([custom]);
  });

  it("does not invent a tracker binding without a current registry row", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());
    const base = entitiesFrom(generated);
    base.__LIBRARY_MANGA_V5[generated.library.id] = {
      ...generated.library,
      attachedSources: generated.library.attachedSources.slice(0, 2),
    };
    const result = migrateLibrarySources(base, generated.library.id, entry, undefined);
    expect(result.sources).toEqual([]);
    expect(result.library.attachedSources).toHaveLength(2);
  });

  it("does not replace a conflicting provider attachment", () => {
    const generated = buildEntitiesForEntry(entry, registryRow, new Map());
    const base = entitiesFrom(generated);
    const mangaDex = generated.sources.find((source) => source.sourceId === "MangaDex")!;
    base.__SOURCE_MANGA_V5[mangaDex.id] = {
      ...mangaDex,
      mangaId: "different-mangadex-id",
    };

    const result = migrateLibrarySources(base, generated.library.id, entry, registryRow);
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
    base.__MANGA_INFO_V5[legacyInfoId] =
      generated.infos[String(generated.sources[0]!.mangaInfo.id)]!;
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
    expect(Object.values(cleaned.entities.__SOURCE_MANGA_V5)).not.toContainEqual(
      expect.objectContaining({ sourceId: "ManifoldSource" }),
    );

    const trackerOnly = entitiesFrom(
      buildEntitiesForEntry(
        entry,
        {
          ...registryRow,
          providers: registryRow.providers.filter((provider) => provider.provider === "anilist"),
        },
        new Map(),
      ),
    );
    const pruned = sourceFreeEntities(undefined, trackerOnly);
    expect(pruned.removedProviderlessLibraries).toBe(1);
    expect(pruned.entities.__LIBRARY_MANGA_V5).toEqual({});
    expect(pruned.entities.__SOURCE_MANGA_V5).toEqual({});
  });

  it("requires a proven native content provider", () => {
    expect(hasUpstreamProvider(registryRow)).toBe(true);
    expect(
      hasUpstreamProvider({
        ...registryRow,
        providers: registryRow.providers.filter((provider) => provider.provider === "anilist"),
      }),
    ).toBe(false);
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
