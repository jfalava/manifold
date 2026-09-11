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
import { buildPas5Zip, filterPas5Providers, parsePas5 } from "../src/pas5";
import type {
  LibraryManga,
  LibraryTab,
  MangaInfo,
  Pas5Entities,
  SourceManga,
} from "../src/pas5-model";

interface TestGeneratedEntry {
  readonly library: LibraryManga;
  readonly sources: readonly SourceManga[];
  readonly infos: Record<string, MangaInfo>;
}

interface TestExistingUpstreamResult {
  readonly library: LibraryManga;
  readonly sources: readonly SourceManga[];
  readonly infos: Record<string, MangaInfo>;
  readonly conflicts: number;
}

interface TestSourceFreeResult {
  readonly entities: Pas5Entities;
  readonly removedLegacySources: number;
  readonly removedProviderlessLibraries: number;
}

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

const buildEntry = (
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
): TestGeneratedEntry => {
  // SAFETY: buildEntitiesForEntry declares this exact structural result contract.
  return buildEntitiesForEntry(entry, registryRow, new Map()) as TestGeneratedEntry;
};

const migrate = (
  base: Pas5Entities,
  libraryId: string,
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
  sharedTabs: ReadonlyMap<string, LibraryTab> = new Map(),
): TestExistingUpstreamResult => {
  // SAFETY: migrateLibrarySources declares this exact structural result contract.
  return migrateLibrarySources(
    base,
    libraryId,
    entry,
    registryRow,
    sharedTabs,
  ) as TestExistingUpstreamResult;
};

const sourceFree = (
  base: Pas5Entities | undefined,
  updates: Pas5Entities,
): TestSourceFreeResult => {
  // SAFETY: sourceFreeEntities declares this exact structural result contract.
  return sourceFreeEntities(base, updates) as TestSourceFreeResult;
};

const entitiesFrom = (generated: TestGeneratedEntry): Pas5Entities => ({
  __LIBRARY_MANGA_V5: { [generated.library.id]: generated.library },
  __SOURCE_MANGA_V5: Object.fromEntries(generated.sources.map((source) => [source.id, source])),
  __MANGA_INFO_V5: generated.infos,
});

describe("al2pas5 source attachments", () => {
  it.each([
    ["MangaDex", ["Comix", "MANIFOLD"]],
    ["Comix", ["MangaDex", "MANIFOLD"]],
    ["MANIFOLD", ["MangaDex", "Comix"]],
  ] as const)(
    "isolates %s without changing entry identity or metadata",
    async (retained, excluded) => {
      const original = entitiesFrom(buildEntry(entry, registryRow));
      const source = Object.values(original.__SOURCE_MANGA_V5).find(
        (s) => s.sourceId === retained,
      )!;
      const result = filterPas5Providers(original, new Set(excluded));
      expect(result.__SOURCE_MANGA_V5).toEqual({ [source.id]: source });
      expect(result.__MANGA_INFO_V5).toEqual({
        [source.mangaInfo.id]: original.__MANGA_INFO_V5[source.mangaInfo.id],
      });
      const library = Object.values(original.__LIBRARY_MANGA_V5)[0]!;
      expect(result.__LIBRARY_MANGA_V5).toEqual({
        [library.id]: {
          ...library,
          attachedSources: [{ id: source.id, type: "__SOURCE_MANGA_V5" }],
        },
      });
      expect(
        await parsePas5(
          buildPas5Zip(
            Object.fromEntries(
              Object.entries(result).map(([name, records]) => [name, JSON.stringify(records)]),
            ),
          ),
        ),
      ).toEqual(result);
      expect(Object.values(original.__SOURCE_MANGA_V5)).toHaveLength(3);
    },
  );

  it("drops entries missing the remaining provider and retains shared metadata", () => {
    const generated = buildEntry(entry, registryRow);
    const original = entitiesFrom(generated);
    const [mangadex, comix, tracker] = generated.sources;
    original.__SOURCE_MANGA_V5[comix!.id] = { ...comix!, mangaInfo: mangadex!.mangaInfo };
    original.__LIBRARY_MANGA_V5["tracker-only"] = {
      ...generated.library,
      id: "tracker-only",
      attachedSources: [{ id: tracker!.id, type: "__SOURCE_MANGA_V5" }],
    };
    const filtered = filterPas5Providers(original, new Set(["MANIFOLD", "MangaDex"]));
    expect(Object.keys(filtered.__LIBRARY_MANGA_V5)).toEqual([generated.library.id]);
    expect(Object.keys(filtered.__MANGA_INFO_V5)).toEqual([mangadex!.mangaInfo.id]);
    expect(filtered.__SOURCE_MANGA_V5).toEqual({
      [comix!.id]: { ...comix!, mangaInfo: mangadex!.mangaInfo },
    });
  });

  it("removes excluded chapters and their markers across chunks, preserving unrelated data", () => {
    const original = entitiesFrom(buildEntry(entry, registryRow));
    const [mangadex, comix] = Object.values(original.__SOURCE_MANGA_V5);
    const keptChapter = { id: "kept", sourceManga: { id: comix!.id, type: "__SOURCE_MANGA_V5" } };
    const keptMarker = { id: "marker-kept", chapter: { id: "kept", type: "__CHAPTER_V5" } };
    const archive = {
      ...original,
      __CHAPTER_PROGRESS_MARKER_V5: { dropped: { chapter: { id: "chapter-id" } } },
      "__CHAPTER_PROGRESS_MARKER_V5-2": { keptMarker },
      "__CHAPTER_V5-1": {
        "chapter-key": { id: "chapter-id", sourceManga: { id: mangadex!.id } },
      },
      "__CHAPTER_V5-2": { kept: keptChapter },
      __OTHER_ENTITY: { untouched: { value: 123 } },
    };
    expect(filterPas5Providers(archive, new Set(["MangaDex"]))).toMatchObject({
      __CHAPTER_PROGRESS_MARKER_V5: {},
      "__CHAPTER_PROGRESS_MARKER_V5-2": { keptMarker },
      "__CHAPTER_V5-1": {},
      "__CHAPTER_V5-2": { kept: keptChapter },
      __OTHER_ENTITY: archive.__OTHER_ENTITY,
    });
    const filtered = filterPas5Providers(archive, new Set(["MangaDex"]));
    expect(Object.keys(filtered.__SOURCE_MANGA_V5)).toHaveLength(2);
    // Empty expectations in toMatchObject alone would not detect leftover records.
    expect(
      Object.fromEntries(
        Object.entries(filtered).filter(
          ([name]) => name === "__CHAPTER_PROGRESS_MARKER_V5" || name === "__CHAPTER_V5-1",
        ),
      ),
    ).toEqual({ __CHAPTER_PROGRESS_MARKER_V5: {}, "__CHAPTER_V5-1": {} });
  });

  it("uses the uppercase library UUID representation found in device exports", () => {
    const generated = buildEntry(entry, registryRow);
    expect(generated.library.id).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
    );
  });

  it("uses uppercase source UUIDs and preserves actual provider IDs", () => {
    const generated = buildEntry(entry, registryRow);
    const uppercaseUuid = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
    for (const source of generated.sources) {
      expect(source.id).toMatch(uppercaseUuid);
    }
    // Attached references point at the same (uppercase) source ids.
    expect(generated.library.attachedSources.map((reference) => reference.id)).toEqual(
      generated.sources.map((source) => source.id),
    );
    // Provider identities are untouched: real registry UUID and provider IDs.
    expect(generated.sources.map(({ sourceId, mangaId }) => ({ sourceId, mangaId }))).toEqual([
      { sourceId: "MangaDex", mangaId: "mangadex-id" },
      { sourceId: "Comix", mangaId: "comix-id" },
      { sourceId: "MANIFOLD", mangaId: "canonical-id" },
    ]);
  });

  it("repairs lowercase base library keys and IDs without changing source identities", async () => {
    const generated = buildEntry(entry, registryRow);
    const lowercaseId = "8f856402-f384-4dc5-89da-25089bb9e15f";
    const uppercaseId = "8F856402-F384-4DC5-89DA-25089BB9E15F";
    const library = { ...generated.library, id: lowercaseId };
    const base = {
      ...entitiesFrom(generated),
      __LIBRARY_MANGA_V5: { [lowercaseId]: library },
    };
    const empty = {
      __LIBRARY_MANGA_V5: {},
      __SOURCE_MANGA_V5: {},
      __MANGA_INFO_V5: {},
    };
    const repaired = sourceFree(base, empty).entities;
    const roundTrip = await parsePas5(
      buildPas5Zip(
        Object.fromEntries(
          Object.entries(repaired).map(([name, records]) => [name, JSON.stringify(records)]),
        ),
      ),
    );

    expect(roundTrip.__LIBRARY_MANGA_V5).toEqual({
      [uppercaseId]: { ...library, id: uppercaseId },
    });
    expect(roundTrip.__SOURCE_MANGA_V5).toEqual(base.__SOURCE_MANGA_V5);
    expect(roundTrip.__MANGA_INFO_V5).toEqual(base.__MANGA_INFO_V5);
    expect(sourceFree(roundTrip, empty).entities).toEqual(roundTrip);
  });

  it("adds every proven upstream provider to new library entries", () => {
    const generated = buildEntry(entry, registryRow);

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
    const original = entitiesFrom(buildEntry(entry, originalRow));
    const matches = matchingBaseLibraryIds(original, entry, registryRow);

    expect(matches).toEqual([Object.keys(original.__LIBRARY_MANGA_V5)[0]]);
    const result = migrate(original, matches[0]!, entry, registryRow);
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
    expect(migrate(enriched, matches[0]!, entry, registryRow).sources).toHaveLength(0);
  });

  it("replaces a stale tracker UUID and prunes its orphaned metadata", () => {
    const generated = buildEntry(entry, {
      ...registryRow,
      id: "91a074d5-6c22-42cc-9846-3d55a32bfa83",
    });
    const base = entitiesFrom(generated);
    expect(matchingBaseLibraryIds(base, entry, registryRow)).toEqual([generated.library.id]);
    const result = migrate(base, generated.library.id, entry, registryRow);
    expect(result.conflicts).toBe(0);
    expect(result.sources).toEqual([
      expect.objectContaining({ sourceId: "MANIFOLD", mangaId: registryRow.id }),
    ]);
    const cleaned: Pas5Entities = sourceFree(base, {
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
    expect(migrate(cleaned, generated.library.id, entry, registryRow).sources).toHaveLength(0);
  });

  it("fills missing tabs without new sources and preserves existing collections", () => {
    const generated = buildEntry(entry, registryRow);
    const base = entitiesFrom(generated);
    const tab = { id: "shared-reading", name: "Reading", sortOrder: 0 };
    const tabs = new Map([[tab.name, tab]]);
    const result = migrate(base, generated.library.id, entry, registryRow, tabs);
    expect(result.sources).toHaveLength(0);
    expect(result.library.libraryTabs).toEqual([tab]);
    expect(migrate(base, generated.library.id, entry, registryRow).library.libraryTabs).toEqual([]);
    const custom = { id: "custom", name: "Favorites", sortOrder: 5 };
    base.__LIBRARY_MANGA_V5[generated.library.id] = { ...generated.library, libraryTabs: [custom] };
    expect(
      migrate(base, generated.library.id, entry, registryRow, tabs).library.libraryTabs,
    ).toEqual([custom]);
  });

  it("does not invent a tracker binding without a current registry row", () => {
    const generated = buildEntry(entry, registryRow);
    const base = entitiesFrom(generated);
    base.__LIBRARY_MANGA_V5[generated.library.id] = {
      ...generated.library,
      attachedSources: generated.library.attachedSources.slice(0, 2),
    };
    const result = migrate(base, generated.library.id, entry, undefined);
    expect(result.sources).toEqual([]);
    expect(result.library.attachedSources).toHaveLength(2);
  });

  it("does not replace a conflicting provider attachment", () => {
    const generated = buildEntry(entry, registryRow);
    const base = entitiesFrom(generated);
    const mangaDex = generated.sources.find((source) => source.sourceId === "MangaDex")!;
    base.__SOURCE_MANGA_V5[mangaDex.id] = {
      ...mangaDex,
      mangaId: "different-mangadex-id",
    };

    const result = migrate(base, generated.library.id, entry, registryRow);
    expect(result.sources).toHaveLength(0);
    expect(result.conflicts).toBe(1);
  });

  it("removes ManifoldSource and drops tracker-only libraries", () => {
    const generated = buildEntry(entry, registryRow);
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

    const cleaned = sourceFree(base, {
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
      buildEntry(entry, {
        ...registryRow,
        providers: registryRow.providers.filter((provider) => provider.provider === "anilist"),
      }),
    );
    const pruned = sourceFree(undefined, trackerOnly);
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
    const generated = buildEntry(entry, registryRow);
    const base = entitiesFrom(generated);
    const unrelated: AniListRichEntry = {
      ...entry,
      mediaId: 999,
      title: "Unrelated Manga",
    };

    expect(matchingBaseLibraryIds(base, unrelated, undefined)).toEqual([]);
  });
});
