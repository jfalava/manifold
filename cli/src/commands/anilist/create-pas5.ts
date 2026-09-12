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
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage, isFiniteNumber, type JsonObject } from "@manifold/json";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { fetchAniListRichEntries, type AniListRichEntry } from "@/anilist";
import { resolveAniListToken } from "@/login/anilist";
import { buildPas5Zip, filterPas5Providers, parsePas5, type Pas5Entities } from "@/pas5";
import {
  coreDataFromUnix,
  coreDataNow,
  deterministicUuid,
  infoStatusFor,
  LAST_READ_NEVER,
  mangaInfoKey,
  tabForStatus,
  TAB_ORDER,
  type LibraryManga,
  type LibraryTab,
  type MangaInfo,
  type SourceManga,
} from "@/pas5-model";
import {
  apiConfig,
  type ApiConfig,
  type RegistryRow,
  registryByAnilistId,
} from "@/commands/toolbox";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";

const SOURCE_ID = "ManifoldSource";
const TRACKER_SOURCE_ID = "MANIFOLD";
const UPSTREAM_SOURCES = [
  { provider: "mangadex", sourceId: "MangaDex" },
  { provider: "comix", sourceId: "Comix" },
] as const;

const DEFAULT_BASE_HINT = "a real device export (*.pas5) — restore may REPLACE the library";

const parseTabsFlag = (value: string): readonly string[] | "none" | undefined => {
  if (value === "auto") {
    return undefined;
  }
  if (value === "none") {
    return "none";
  }
  const allowed = new Map(TAB_ORDER.map((name) => [name.toLowerCase(), name]));
  const names = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (names.length === 0) {
    throw new Error(`--tabs: no valid tab names in "${value}"`);
  }
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(`--tabs: unknown tab "${name}" (allowed: ${[...allowed.keys()].join(", ")})`);
    }
  }
  // SAFETY: value matches string); at this call site
  return [...new Set(names)].map((name) => allowed.get(name) as string);
};

export interface GeneratedEntry {
  readonly library: LibraryManga;
  readonly sources: readonly SourceManga[];
  readonly infos: Record<string, MangaInfo>;
}

const buildMangaInfo = (
  entry: AniListRichEntry,
  additionalInfo: Record<string, string>,
): MangaInfo => {
  const secondary = new Set<string>();
  if (entry.romajiTitle && entry.romajiTitle !== entry.title) {
    secondary.add(entry.romajiTitle);
  }
  if (entry.nativeTitle && entry.nativeTitle !== entry.title) {
    secondary.add(entry.nativeTitle);
  }
  for (const synonym of entry.synonyms) {
    secondary.add(synonym);
  }
  secondary.delete(entry.title);

  return {
    synopsis: entry.description ?? "",
    status: infoStatusFor(entry.mediaStatus),
    contentType: "comic",
    tagGroups: [],
    additionalInfo,
    schemaVersion: 1,
    primaryTitle: entry.title,
    artworkUrls: [],
    thumbnailUrl: entry.coverUrl ?? "",
    contentRating: "SAFE",
    rating: isFiniteNumber(entry.averageScore) ? entry.averageScore / 100 : 0,
    secondaryTitles: [...secondary],
  };
};

const makeSourceManga = (sourceId: string, mangaId: string, infoId: string): SourceManga => ({
  // Uppercase, matching native device exports: the user-verified restore test
  // archive has uppercase source+library UUIDs, while lowercase generator
  // output was implicated in Paperback duplicate objects (memories 1202/1203).
  id: randomUUID().toUpperCase(),
  sourceId,
  schemaVersion: 1,
  mangaId,
  mangaInfo: { id: infoId, type: "__MANGA_INFO_V5" },
});

const upstreamEntitiesForEntry = (
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
): Pick<GeneratedEntry, "sources" | "infos"> => {
  const sources: SourceManga[] = [];
  const infos: Record<string, MangaInfo> = {};
  for (const upstream of UPSTREAM_SOURCES) {
    const externalId = registryRow?.providers.find(
      (provider) => provider.provider === upstream.provider,
    )?.externalId;
    if (!externalId) {
      continue;
    }
    const infoId = mangaInfoKey(upstream.sourceId, externalId);
    sources.push(makeSourceManga(upstream.sourceId, externalId, infoId));
    infos[infoId] = buildMangaInfo(entry, {});
  }
  return { sources, infos };
};

export const hasUpstreamProvider = (registryRow: RegistryRow | undefined): boolean =>
  UPSTREAM_SOURCES.some((upstream) =>
    registryRow?.providers.some((provider) => provider.provider === upstream.provider),
  );

export const buildEntitiesForEntry = (
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
  sharedTabs: ReadonlyMap<string, LibraryTab>,
): GeneratedEntry => {
  const mangaId = registryRow?.id ?? `anilist:${entry.mediaId}`;
  const trackerInfo = buildMangaInfo(entry, {
    "Canonical ID": mangaId,
    "Canonical provider": "anilist",
    "Canonical provider ID": String(entry.mediaId),
    "AniList ID": String(entry.mediaId),
  });

  const trackerInfoId = mangaInfoKey(TRACKER_SOURCE_ID, mangaId);
  const upstream = upstreamEntitiesForEntry(entry, registryRow);
  const sources: SourceManga[] = [
    ...upstream.sources,
    makeSourceManga(TRACKER_SOURCE_ID, mangaId, trackerInfoId),
  ];
  const tabName = tabForStatus(entry.status);
  // SAFETY: value is LibraryTab] at this site
  const libraryTabs =
    tabName !== undefined && sharedTabs.has(tabName)
      ? // SAFETY: value matches LibraryTab] at this call site
        [sharedTabs.get(tabName) as LibraryTab]
      : [];

  // Match the uppercase LibraryManga UUID representation in native device exports.
  const libraryId = randomUUID().toUpperCase();
  return {
    library: {
      schemaVersion: 1,
      attachedSources: sources.map((source) => ({
        id: source.id,
        type: "__SOURCE_MANGA_V5",
      })),
      lastUpdated: coreDataNow(),
      dateBookmarked:
        entry.createdAt !== undefined ? coreDataFromUnix(entry.createdAt) : coreDataNow(),
      lastRead: LAST_READ_NEVER,
      id: libraryId,
      libraryTabs,
    },
    sources,
    infos: {
      ...upstream.infos,
      [trackerInfoId]: trackerInfo,
    },
  };
};

export const matchingBaseLibraryIds = (
  base: Pas5Entities,
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
): readonly string[] => {
  const canonicalId = registryRow?.id;
  const fallbackId = `anilist:${entry.mediaId}`;
  const providerIds = new Map<string, string>(
    UPSTREAM_SOURCES.flatMap((upstream) => {
      const externalId = registryRow?.providers.find(
        (provider) => provider.provider === upstream.provider,
      )?.externalId;
      return externalId ? [[upstream.sourceId, externalId] as const] : [];
    }),
  );

  return Object.entries(base.__LIBRARY_MANGA_V5)
    .filter(([, library]) =>
      library.attachedSources.some((reference) => {
        const source = base.__SOURCE_MANGA_V5[reference.id];
        if (!source) {
          return false;
        }
        if (source.mangaId === canonicalId || source.mangaId === fallbackId) {
          return true;
        }
        if (providerIds.get(source.sourceId) === source.mangaId) {
          return true;
        }
        const info = base.__MANGA_INFO_V5[String(source.mangaInfo.id)];
        if (!info) {
          return false;
        }
        if (canonicalId !== undefined && info.additionalInfo?.["Canonical ID"] === canonicalId) {
          return true;
        }
        const aniListId =
          info.additionalInfo?.["AniList ID"] ??
          (info.additionalInfo?.["Canonical provider"] === "anilist"
            ? info.additionalInfo?.["Canonical provider ID"]
            : undefined);
        return aniListId === String(entry.mediaId);
      }),
    )
    .map(([libraryId]) => libraryId);
};

export interface ExistingUpstreamResult extends Pick<GeneratedEntry, "sources" | "infos"> {
  readonly library: LibraryManga;
  readonly conflicts: number;
}

export const migrateLibrarySources = (
  base: Pas5Entities,
  libraryId: string,
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
  sharedTabs: ReadonlyMap<string, LibraryTab> = new Map(),
): ExistingUpstreamResult => {
  const library = base.__LIBRARY_MANGA_V5[libraryId];
  if (!library) {
    throw new Error(`Missing base library entry ${libraryId}`);
  }
  const attached = library.attachedSources
    .map((reference) => base.__SOURCE_MANGA_V5[reference.id])
    .filter((source): source is SourceManga => source !== undefined);
  const upstream = upstreamEntitiesForEntry(entry, registryRow);
  const mangaId = registryRow?.id ?? `anilist:${entry.mediaId}`;
  const trackerInfoId = mangaInfoKey(TRACKER_SOURCE_ID, mangaId);
  const tracker = makeSourceManga(TRACKER_SOURCE_ID, mangaId, trackerInfoId);
  // Only current registry rows can authorize a replacement tracker binding.
  const candidates = [...upstream.sources, ...(registryRow ? [tracker] : [])];
  const candidateInfos = {
    ...upstream.infos,
    [trackerInfoId]: buildMangaInfo(entry, {
      "Canonical ID": mangaId,
      "Canonical provider": "anilist",
      "Canonical provider ID": String(entry.mediaId),
      "AniList ID": String(entry.mediaId),
    }),
  };
  const sources: SourceManga[] = [];
  const infos: Record<string, MangaInfo> = {};
  let conflicts = 0;

  for (const candidate of candidates) {
    const sameSource = attached.filter((source) => source.sourceId === candidate.sourceId);
    if (sameSource.some((source) => source.mangaId === candidate.mangaId)) {
      continue;
    }
    if (sameSource.length > 0 && candidate.sourceId !== TRACKER_SOURCE_ID) {
      conflicts++;
      continue;
    }
    sources.push(candidate);
    const info = candidateInfos[String(candidate.mangaInfo.id)];
    if (info) {
      infos[String(candidate.mangaInfo.id)] = info;
    }
  }

  const retainedReferences = library.attachedSources.filter((reference) => {
    const source = base.__SOURCE_MANGA_V5[reference.id];
    return (
      source?.sourceId !== SOURCE_ID &&
      !(registryRow && source?.sourceId === TRACKER_SOURCE_ID && source.mangaId !== registryRow.id)
    );
  });
  const tabName = tabForStatus(entry.status);
  const tab = tabName === undefined ? undefined : sharedTabs.get(tabName);
  const libraryTabs = library.libraryTabs.length === 0 && tab ? [tab] : library.libraryTabs;

  return {
    library: {
      ...library,
      libraryTabs,
      attachedSources: [
        ...retainedReferences,
        ...sources.map((source) => ({
          id: source.id,
          type: "__SOURCE_MANGA_V5" as const,
        })),
      ],
      lastUpdated:
        sources.length > 0 ||
        retainedReferences.length !== library.attachedSources.length ||
        libraryTabs !== library.libraryTabs
          ? coreDataNow()
          : library.lastUpdated,
    },
    sources,
    infos,
    conflicts,
  };
};

export interface SourceFreeResult {
  readonly entities: Pas5Entities;
  readonly removedLegacySources: number;
  readonly removedProviderlessLibraries: number;
}

export const sourceFreeEntities = (
  base: Pas5Entities | undefined,
  updates: Pas5Entities,
): SourceFreeResult => {
  const libraries = {
    ...base?.__LIBRARY_MANGA_V5,
    ...updates.__LIBRARY_MANGA_V5,
  };
  const allSources = {
    ...base?.__SOURCE_MANGA_V5,
    ...updates.__SOURCE_MANGA_V5,
  };
  const allInfos = {
    ...base?.__MANGA_INFO_V5,
    ...updates.__MANGA_INFO_V5,
  };
  const sources = Object.fromEntries(
    Object.entries(allSources).filter(([, source]) => source.sourceId !== SOURCE_ID),
  );
  const sourceFreeLibraries = Object.fromEntries(
    Object.entries(libraries).map(([id, library]) => [
      // Also repair library UUIDs emitted by older generator versions in --base.
      id.toUpperCase(),
      {
        ...library,
        id: library.id.toUpperCase(),
        attachedSources: library.attachedSources.filter((reference) => reference.id in sources),
      },
    ]),
  );
  const retainedLibraries = Object.fromEntries(
    Object.entries(sourceFreeLibraries).filter(([, library]) =>
      library.attachedSources.some(
        (reference) => sources[reference.id]?.sourceId !== TRACKER_SOURCE_ID,
      ),
    ),
  );
  const usedSourceIds = new Set(
    Object.values(retainedLibraries).flatMap((library) =>
      library.attachedSources.map((reference) => reference.id),
    ),
  );
  const retainedSources = Object.fromEntries(
    Object.entries(sources).filter(([id]) => usedSourceIds.has(id)),
  );
  const usedInfoIds = new Set(
    Object.values(retainedSources).map((source) => String(source.mangaInfo.id)),
  );
  const retainedInfos = Object.fromEntries(
    Object.entries(allInfos).filter(([id]) => usedInfoIds.has(id)),
  );

  return {
    entities: {
      __LIBRARY_MANGA_V5: retainedLibraries,
      __SOURCE_MANGA_V5: retainedSources,
      __MANGA_INFO_V5: retainedInfos,
    },
    removedLegacySources: Object.keys(allSources).length - Object.keys(sources).length,
    removedProviderlessLibraries:
      Object.keys(sourceFreeLibraries).length - Object.keys(retainedLibraries).length,
  };
};

const filterPas5Command = Command.make("filter", {
  input: Flag.String("input").pipe(
    Flag.withDescription("Existing .pas5 archive to filter offline."),
  ),
  out: Flag.String("out").pipe(
    Flag.withDescription("Filtered archive path (must differ from input)."),
  ),
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
  excludeMangadex: Flag.Boolean("exclude-mangadex").pipe(Flag.withDefault(false)),
  excludeComix: Flag.Boolean("exclude-comix").pipe(Flag.withDefault(false)),
  excludeTracker: Flag.Boolean("exclude-tracker").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription(
    "Isolate PAS5 providers without fetching AniList or registry data; tracker-only entries are retained.",
  ),
  Command.withHandler(({ input, out, apply, excludeMangadex, excludeComix, excludeTracker }) =>
    Effect.tryPromise({
      try: async () => {
        const excluded = new Set([
          ...(excludeMangadex ? ["MangaDex"] : []),
          ...(excludeComix ? ["Comix"] : []),
          ...(excludeTracker ? ["MANIFOLD"] : []),
        ]);
        if (excluded.size === 0 || excluded.size === 3) {
          throw new Error(
            "Exclude one or two providers with --exclude-mangadex, --exclude-comix, or --exclude-tracker.",
          );
        }
        if (resolve(input) === resolve(out)) {
          throw new Error("--out must differ from --input; keep the original backup.");
        }
        const original = await parsePas5(readFileSync(input));
        const filtered = filterPas5Providers(original, excluded);
        const count = Object.keys(filtered.__LIBRARY_MANGA_V5).length;
        console.info(
          `Libraries retained: ${count}; omitted without remaining attachments: ${Object.keys(original.__LIBRARY_MANGA_V5).length - count}`,
        );
        console.info(`Excluded providers: ${[...excluded].join(", ")}`);
        if (!apply) {
          console.info(`Dry-run complete. Re-run with --apply to write ${out}`);
          return;
        }
        const files = Object.fromEntries(
          Object.entries(filtered).map(([name, records]) => [name, JSON.stringify(records)]),
        );
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, buildPas5Zip(files));
        console.info(`Wrote ${out}`);
        console.info(
          "After restoring, run Paperback database repair and verify a title stays categorized after reopening.",
        );
      },
      catch: (cause) => new Error(errorMessage(cause)),
    }),
  ),
);

export const createPas5Command = Command.make("pas5", {
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Write the .pas5 archive (default: dry-run report only)."),
  ),
  tabs: Flag.String("tabs").pipe(
    Flag.withDefault("auto"),
    Flag.withDescription(
      "Library tabs: auto | none | comma-list of reading,paused,dropped,completed,planning.",
    ),
  ),
  base: Flag.String("base").pipe(
    Flag.optional,
    Flag.withDescription(`Seed from an existing .pas5 export (${DEFAULT_BASE_HINT}).`),
  ),
  out: Flag.String("out").pipe(
    Flag.optional,
    Flag.withDescription("Output path (default Paperback-Generated.<date>.<time>.pas5)."),
  ),
  limit: Flag.Int("limit").pipe(
    Flag.optional,
    Flag.withDescription(
      "Only generate the first N titles (canary testing — pairs well with --base).",
    ),
  ),
  anilistToken: Flag.String("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList access token override. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
    ),
  ),
  apiOrigin: Flag.String("api-origin").pipe(
    Flag.optional,
    Flag.withDescription("Personal API origin for registry UUID resolution."),
  ),
  apiToken: Flag.String("api-token").pipe(
    Flag.optional,
    Flag.withDescription("Falls back to MANIFOLD_TOKEN."),
  ),
}).pipe(
  Command.withDescription(
    "Generate a source-free Paperback .pas5 backup with native MangaDex/Comix and MANIFOLD attachments.",
  ),
  Command.withHandler(({ apply, tabs, base, out, limit, anilistToken, apiOrigin, apiToken }) =>
    Effect.gen(function* () {
      const token =
        (yield* Effect.tryPromise(() =>
          resolveAniListToken(Option.getOrUndefined(anilistToken)),
        )) ?? "";
      if (!token) {
        return yield* Effect.fail(
          new Error(
            "Missing AniList token: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.",
          ),
        );
      }
      const tabFilter = yield* Effect.try({
        try: () => parseTabsFlag(tabs),
        catch: (cause) => new Error(errorMessage(cause)),
      });

      interface ScanCtx extends RunContext {
        entries: readonly AniListRichEntry[];
        registry: Map<string, RegistryRow>;
        base?: Pas5Entities;
      }
      const scan: ScanCtx = yield* Effect.tryPromise({
        try: async () => {
          openFrame("anilist create pas5");
          let fetchedEntries: readonly AniListRichEntry[] = [];
          let registry = new Map<string, RegistryRow>();
          let baseEntities: Pas5Entities | undefined;
          // SAFETY: value is asserted type at this site
          const run = createRun<JsonObject>([
            // SAFETY: value matches ApiConfig; registry = await registryByAnilistId(config); makePhaseReporter(task) at this call site
            {
              title: "Fetch AniList manga list",
              task: async (_, task) => {
                fetchedEntries = await fetchAniListRichEntries(token);
                makePhaseReporter(task).note(`${fetchedEntries.length} list entries fetched.`);
              },
            },
            {
              title: "Resolve registry UUIDs",
              task: async (_, task) => {
                // SAFETY: value matches ApiConfig; at this call site
                const config = apiConfig(apiOrigin, apiToken) as ApiConfig;
                registry = await registryByAnilistId(config);
                makePhaseReporter(task).note(
                  `${registry.size} registry rows with an AniList link.`,
                );
              },
            },
          ] as Parameters<typeof createRun<JsonObject>>[0]);
          const basePath = Option.getOrUndefined(base);
          if (basePath !== undefined) {
            const baseTasks: Parameters<typeof createRun<JsonObject>>[0] = [
              {
                title: "Read base archive",
                task: async (_, task) => {
                  const parsed = await parsePas5(readFileSync(basePath));
                  // SAFETY: parsePas5 plus empty-map defaults is a complete Pas5Entities.
                  baseEntities = {
                    ...parsed,
                    __LIBRARY_MANGA_V5: parsed.__LIBRARY_MANGA_V5 ?? {},
                    __SOURCE_MANGA_V5: parsed.__SOURCE_MANGA_V5 ?? {},
                    __MANGA_INFO_V5: parsed.__MANGA_INFO_V5 ?? {},
                  } as Pas5Entities;
                  makePhaseReporter(task).note(
                    `${Object.keys(parsed.__LIBRARY_MANGA_V5 ?? {}).length} existing library entries.`,
                  );
                },
              },
            ];
            const baseRun = createRun<JsonObject>(baseTasks);
            try {
              await baseRun.run();
            } catch (error) {
              abortFrame();
              throw error;
            }
          }
          try {
            await run.run();
          } catch (error) {
            abortFrame();
            throw error;
          }
          return {
            entries: fetchedEntries,
            registry,
            ...(baseEntities && { base: baseEntities }),
          };
        },
        catch: (cause) => new Error(errorMessage(cause)),
      });

      const allowedTabs = tabFilter === "none" ? [] : (tabFilter ?? TAB_ORDER);

      // Paperback groups libraryTabs by id, not name — every entry must
      // reference THE SAME tab object per collection. Reuse ids from the
      // base export where present so restored entries land in the user's
      // existing tabs; mint one stable id per new tab for this run.
      const sharedTabs = new Map<string, { name: string; sortOrder: number; id: string }>();
      const baseTabs = new Map<string, { name: string; sortOrder: number; id: string }>();
      if (scan.base) {
        for (const lib of Object.values(scan.base.__LIBRARY_MANGA_V5)) {
          for (const tab of lib.libraryTabs ?? []) {
            if (!baseTabs.has(tab.name)) {
              baseTabs.set(tab.name, tab);
            }
          }
        }
      }
      for (const [index, name] of allowedTabs.entries()) {
        const existing = baseTabs.get(name);
        sharedTabs.set(
          name,
          existing ?? {
            name,
            sortOrder: index,
            id: deterministicUuid(`paperback-tab:${name}`),
          },
        );
      }

      const entities: Pas5Entities = {
        __LIBRARY_MANGA_V5: {},
        __SOURCE_MANGA_V5: {},
        __MANGA_INFO_V5: {},
      };

      let skippedExisting = 0;
      let skippedByTabs = 0;
      let unresolvedUuid = 0;
      let withoutContentProvider = 0;
      let totalGenerated = 0;
      let enrichedExisting = 0;
      let upstreamAttachments = 0;
      let providerConflicts = 0;
      let ambiguousBaseEntries = 0;
      const tabCounts = new Map<string, number>(allowedTabs.map((t) => [t, 0]));

      for (const entry of scan.entries) {
        if (
          limit !== undefined &&
          Option.getOrUndefined(limit) !== undefined &&
          // SAFETY: value matches number) at this call site
          totalGenerated >= (Option.getOrUndefined(limit) as number)
        ) {
          break;
        }
        const registryRow = scan.registry.get(String(entry.mediaId));
        const matchingLibraries = scan.base
          ? matchingBaseLibraryIds(scan.base, entry, registryRow)
          : [];
        if (matchingLibraries.length > 0) {
          skippedExisting++;
          if (matchingLibraries.length > 1) {
            ambiguousBaseEntries++;
            continue;
          }
          // SAFETY: length is exactly one in this branch.
          const libraryId = matchingLibraries[0] as string;
          // SAFETY: scan.base exists when matchingLibraries is non-empty.
          const enriched = migrateLibrarySources(
            scan.base as Pas5Entities,
            libraryId,
            entry,
            registryRow,
            sharedTabs,
          );
          providerConflicts += enriched.conflicts;
          if (!hasUpstreamProvider(registryRow)) {
            withoutContentProvider++;
          }
          if (
            enriched.sources.length > 0 ||
            enriched.library.attachedSources.length !==
              scan.base?.__LIBRARY_MANGA_V5[libraryId]?.attachedSources.length ||
            enriched.library.libraryTabs !== scan.base?.__LIBRARY_MANGA_V5[libraryId]?.libraryTabs
          ) {
            entities.__LIBRARY_MANGA_V5[libraryId] = enriched.library;
            for (const source of enriched.sources) {
              entities.__SOURCE_MANGA_V5[source.id] = source;
            }
            Object.assign(entities.__MANGA_INFO_V5, enriched.infos);
            enrichedExisting++;
            upstreamAttachments += enriched.sources.filter((source) =>
              UPSTREAM_SOURCES.some((upstream) => upstream.sourceId === source.sourceId),
            ).length;
          }
          continue;
        }
        // --tabs doubles as an import filter: titles whose status maps to
        // a collection you excluded are not imported at all ("none" keeps
        // everything, tab-less).
        const entryTab = tabForStatus(entry.status);
        if (tabFilter !== "none" && (entryTab === undefined || !sharedTabs.has(entryTab))) {
          skippedByTabs++;
          continue;
        }
        if (!registryRow) {
          unresolvedUuid++;
          continue;
        }
        if (!hasUpstreamProvider(registryRow)) {
          withoutContentProvider++;
          continue;
        }
        const generated = buildEntitiesForEntry(entry, registryRow, sharedTabs);
        for (const source of generated.sources) {
          entities.__SOURCE_MANGA_V5[source.id] = source;
        }
        Object.assign(entities.__MANGA_INFO_V5, generated.infos);
        entities.__LIBRARY_MANGA_V5[generated.library.id] = generated.library;
        upstreamAttachments += generated.sources.filter((source) =>
          UPSTREAM_SOURCES.some((upstream) => upstream.sourceId === source.sourceId),
        ).length;
        totalGenerated++;
        for (const tab of generated.library.libraryTabs) {
          tabCounts.set(tab.name, (tabCounts.get(tab.name) ?? 0) + 1);
        }
      }

      const sourceFree = sourceFreeEntities(scan.base, entities);

      const lines = [
        `AniList titles: ${scan.entries.length}`,
        `New library entries: ${totalGenerated}`,
        `Existing library entries enriched: ${enrichedExisting}`,
        `MangaDex/Comix attachments added: ${upstreamAttachments}`,
        `Skipped (already in base): ${skippedExisting}`,
        `Skipped (status excluded by --tabs): ${skippedByTabs}`,
        `Skipped (without registry UUID): ${unresolvedUuid}`,
        `Skipped (without content provider in registry): ${withoutContentProvider}`,
        `Base libraries removed after source cleanup: ${sourceFree.removedProviderlessLibraries}`,
        `ManifoldSource attachments removed: ${sourceFree.removedLegacySources}`,
        `Base provider conflicts (left unchanged): ${providerConflicts}`,
        `Ambiguous base matches (left unchanged): ${ambiguousBaseEntries}`,
      ];
      for (const [tab, count] of tabCounts) {
        lines.push(`  ${tab}: ${count}`);
      }

      const stamp = new Date().toISOString().replace("T", ".").slice(0, 19);
      const outPath = Option.getOrUndefined(out) ?? `Paperback-Generated.${stamp}.pas5`;

      if (!apply) {
        for (const line of lines) {
          frameDetail(line);
        }
        closeFrame(`Dry-run complete. Re-run with --apply to write ${outPath}`);
        return;
      }

      const merged: Record<string, string> = {};
      if (scan.base) {
        for (const [name, records] of Object.entries(scan.base)) {
          merged[name] = JSON.stringify(records);
        }
      }
      merged.__LIBRARY_MANGA_V5 = JSON.stringify(sourceFree.entities.__LIBRARY_MANGA_V5);
      merged.__SOURCE_MANGA_V5 = JSON.stringify(sourceFree.entities.__SOURCE_MANGA_V5);
      merged.__MANGA_INFO_V5 = JSON.stringify(sourceFree.entities.__MANGA_INFO_V5);

      for (const line of lines) {
        frameDetail(line);
      }
      yield* Effect.tryPromise({
        try: async () => {
          const zip = buildPas5Zip(merged);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, zip);
          frameDetail(
            "After restoring, run Paperback database repair and verify a title stays categorized after reopening.",
          );
          closeFrame(`Wrote ${outPath}`);
        },
        catch: (cause) => new Error(errorMessage(cause)),
      });
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
  Command.withSubcommands([filterPas5Command]),
);
