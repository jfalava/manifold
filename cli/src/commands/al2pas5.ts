import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage, isFiniteNumber, type JsonObject } from "@manifold/json";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  fetchAniListRichEntries,
  type AniListRichEntry,
} from "@/anilist";
import {
  buildPas5Zip,
  parsePas5,
  type Pas5Entities,
} from "@/pas5";
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
const TRACKER_SOURCE_ID = "ManifoldTracker";

const DEFAULT_BASE_HINT =
  "a real device export (*.pas5) — restore may REPLACE the library";

const parseTabsFlag = (
  value: string,
): readonly string[] | "none" | undefined => {
  if (value === "auto") {return undefined;}
  if (value === "none") {return "none";}
  const allowed = new Map(TAB_ORDER.map((name) => [name.toLowerCase(), name]));
  const names = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (names.length === 0) {throw new Error(`--tabs: no valid tab names in "${value}"`);}
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(
        `--tabs: unknown tab "${name}" (allowed: ${[...allowed.keys()].join(", ")})`,
      );
    }
  }
  // SAFETY: value matches string); at this call site
  return [...new Set(names)].map((name) => allowed.get(name) as string);
};

interface GeneratedEntry {
  readonly library: LibraryManga;
  readonly sources: readonly SourceManga[];
  readonly infos: Record<string, MangaInfo>;
}

const buildEntitiesForEntry = (
  entry: AniListRichEntry,
  registryRow: RegistryRow | undefined,
  sharedTabs: ReadonlyMap<string, LibraryTab>,
): GeneratedEntry => {
  const mangaId = registryRow?.id ?? `anilist:${entry.mediaId}`;
  const additionalInfo: Record<string, string> = {};
  additionalInfo["Canonical ID"] = mangaId;
  additionalInfo["Canonical provider"] = "anilist";
  additionalInfo["Canonical provider ID"] = String(entry.mediaId);
  additionalInfo["AniList ID"] = String(entry.mediaId);
  // Stamp a reading provider when the registry already has one so ManifoldSource
  // getChapters does not start provider-less and cache mangadex:0 empties.
  const mangadexId = registryRow?.providers.find((p) => p.provider === "mangadex")
    ?.externalId;
  const comixId = registryRow?.providers.find((p) => p.provider === "comix")
    ?.externalId;
  if (mangadexId) {
    additionalInfo["manifold provider"] = "mangadex";
    additionalInfo["manifold provider ID"] = mangadexId;
  } else if (comixId) {
    additionalInfo["manifold provider"] = "comix";
    additionalInfo["manifold provider ID"] = comixId;
  }

  const secondary = new Set<string>();
  if (entry.romajiTitle && entry.romajiTitle !== entry.title) {
    secondary.add(entry.romajiTitle);
  }
  if (entry.nativeTitle && entry.nativeTitle !== entry.title) {
    secondary.add(entry.nativeTitle);
  }
  for (const synonym of entry.synonyms) {secondary.add(synonym);}
  secondary.delete(entry.title);

  const baseInfo: Omit<MangaInfo, never> = {
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
    rating:
      isFiniteNumber(entry.averageScore) ? entry.averageScore / 100 : 0,
    secondaryTitles: [...secondary],
  };
  // Tracker half stays AniList-identity only; content half carries the reading
  // provider stamp above.
  const trackerInfo: MangaInfo = {
    ...baseInfo,
    additionalInfo: {
      "Canonical ID": mangaId,
      "Canonical provider": "anilist",
      "Canonical provider ID": String(entry.mediaId),
      "AniList ID": String(entry.mediaId),
    },
  };

  const sourceIds = [SOURCE_ID, TRACKER_SOURCE_ID];
  const infoKeys = sourceIds.map((sourceId) => mangaInfoKey(sourceId, mangaId));
  const infoIds = sourceIds.map(
    (_, index) =>
      ({
        id: infoKeys[index],
        type: "__MANGA_INFO_V5",
      }) as const,
  );
  const sources: SourceManga[] = sourceIds.map((sourceId, index) => ({
    id: randomUUID(),
    sourceId,
    schemaVersion: 1,
    mangaId,
    mangaInfo: infoIds[index],
  }));
  const tabName = tabForStatus(entry.status);
  // SAFETY: value is LibraryTab] at this site
  const libraryTabs =
    tabName !== undefined && sharedTabs.has(tabName)
      // SAFETY: value matches LibraryTab] at this call site
      ? [sharedTabs.get(tabName) as LibraryTab]
      : [];

  const libraryId = randomUUID();
  return {
    library: {
      schemaVersion: 1,
      attachedSources: sources.map((source) => ({
        id: source.id,
        type: "__SOURCE_MANGA_V5",
      })),
      lastUpdated: coreDataNow(),
      dateBookmarked:
        entry.createdAt !== undefined
          ? coreDataFromUnix(entry.createdAt)
          : coreDataNow(),
      lastRead: LAST_READ_NEVER,
      id: libraryId,
      libraryTabs,
    },
    sources,
    infos: {
      [infoKeys[0]!]: baseInfo,
      [infoKeys[1]!]: trackerInfo,
    },
  };
};

export const al2Pas5Command = Command.make("al2pas5", {
  apply: Flag.boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Write the .pas5 archive (default: dry-run report only)."),
  ),
  tabs: Flag.string("tabs").pipe(
    Flag.withDefault("auto"),
    Flag.withDescription(
      "Library tabs: auto | none | comma-list of reading,paused,dropped,completed,planning.",
    ),
  ),
  base: Flag.string("base").pipe(
    Flag.optional,
    Flag.withDescription(`Seed from an existing .pas5 export (${DEFAULT_BASE_HINT}).`),
  ),
  out: Flag.string("out").pipe(
    Flag.optional,
    Flag.withDescription("Output path (default Paperback-Generated.<date>.<time>.pas5)."),
  ),
  limit: Flag.integer("limit").pipe(
    Flag.optional,
    Flag.withDescription(
      "Only generate the first N titles (canary testing — pairs well with --base).",
    ),
  ),
  anilistToken: Flag.string("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription("Falls back to MANIFOLD_ANILIST_TOKEN."),
  ),
  apiOrigin: Flag.string("api-origin").pipe(
    Flag.optional,
    Flag.withDescription("Personal API origin for registry UUID resolution."),
  ),
  apiToken: Flag.string("api-token").pipe(
    Flag.optional,
    Flag.withDescription("Falls back to MANIFOLD_TOKEN."),
  ),
}).pipe(
  Command.withDescription(
    "Generate a Paperback .pas5 backup from the AniList manga list: ManifoldSource+Tracker per title. Stamps manifold provider from registry mangadex/comix links when present.",
  ),
  Command.withHandler(
    ({
      apply,
      tabs,
      base,
      out,
      limit,
      anilistToken,
      apiOrigin,
      apiToken,
    }) => {
      const token =
        Option.getOrUndefined(anilistToken) ??
        process.env.MANIFOLD_ANILIST_TOKEN ??
        "";
      return Effect.gen(function* () {
        const tabFilter = yield* Effect.try({
          try: () => parseTabsFlag(tabs),
          catch: (cause) =>
            new Error(errorMessage(cause)),
        });

        interface ScanCtx extends RunContext {
          entries: readonly AniListRichEntry[];
          registry: Map<string, RegistryRow>;
          base?: Pas5Entities;
        }
        const scan: ScanCtx = yield* Effect.tryPromise({
          try: async () => {
            openFrame("al2pas5");
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
                  makePhaseReporter(task).note(
                    `${fetchedEntries.length} list entries fetched.`,
                  );
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
              const baseTasks: Parameters<
                typeof createRun<JsonObject>
              >[0] = [
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
              const baseRun =
                createRun<JsonObject>(baseTasks);
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
          catch: (cause) =>
            new Error(errorMessage(cause)),
        });

        const allowedTabs =
          tabFilter === "none"
            ? []
            : (tabFilter ?? TAB_ORDER);

        // Paperback groups libraryTabs by id, not name — every entry must
        // reference THE SAME tab object per collection. Reuse ids from the
        // base export where present so restored entries land in the user's
        // existing tabs; mint one stable id per new tab for this run.
        const sharedTabs = new Map<string, { name: string; sortOrder: number; id: string }>();
        const baseTabs = new Map<string, { name: string; sortOrder: number; id: string }>();
        if (scan.base) {
          for (const lib of Object.values(scan.base.__LIBRARY_MANGA_V5)) {
            for (const tab of lib.libraryTabs ?? []) {
              if (!baseTabs.has(tab.name)) {baseTabs.set(tab.name, tab);}
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

        const existingMangaIds = new Set<string>();
        const existingAniListIds = new Set<string>();
        if (scan.base) {
          for (const source of Object.values(scan.base.__SOURCE_MANGA_V5)) {
            existingMangaIds.add(source.mangaId);
          }
          for (const info of Object.values(scan.base.__MANGA_INFO_V5)) {
            const aniListId =
              info.additionalInfo?.["AniList ID"] ??
              info.additionalInfo?.["Canonical provider ID"];
            if (aniListId !== undefined) {existingAniListIds.add(aniListId);}
          }
        }

        const entities: Pas5Entities = {
          __LIBRARY_MANGA_V5: {},
          __SOURCE_MANGA_V5: {},
          __MANGA_INFO_V5: {},
        };

        let skippedExisting = 0;
        let skippedByTabs = 0;
        let unresolvedUuid = 0;
        let totalGenerated = 0;
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
          const mangaId = registryRow?.id ?? `anilist:${entry.mediaId}`;
          // A title already in the base may be stored under its registry
          // UUID or the anilist:<id> fallback — treat either as existing.
          if (
            existingMangaIds.has(mangaId) ||
            existingMangaIds.has(`anilist:${entry.mediaId}`) ||
            existingAniListIds.has(String(entry.mediaId))
          ) {
            skippedExisting++;
            continue;
          }
          if (!registryRow) {unresolvedUuid++;}
          // --tabs doubles as an import filter: titles whose status maps to
          // a collection you excluded are not imported at all ("none" keeps
          // everything, tab-less).
          const entryTab = tabForStatus(entry.status);
          if (tabFilter !== "none" && (entryTab === undefined || !sharedTabs.has(entryTab))) {
            skippedByTabs++;
            continue;
          }
          const generated = buildEntitiesForEntry(
            entry,
            registryRow,
            sharedTabs,
          );
          for (const source of generated.sources) {
            entities.__SOURCE_MANGA_V5[source.id] = source;
          }
          Object.assign(entities.__MANGA_INFO_V5, generated.infos);
          entities.__LIBRARY_MANGA_V5[generated.library.id] = generated.library;
          totalGenerated++;
          for (const tab of generated.library.libraryTabs) {
            tabCounts.set(tab.name, (tabCounts.get(tab.name) ?? 0) + 1);
          }
        }

        const totalNew = Object.keys(entities.__LIBRARY_MANGA_V5).length;
        const lines = [
          `AniList titles: ${scan.entries.length}`,
          `New library entries: ${totalNew}`,
          `Skipped (already in base): ${skippedExisting}`,
          `Skipped (status excluded by --tabs): ${skippedByTabs}`,
          `Without registry UUID (anilist:<id> fallback): ${unresolvedUuid}`,
        ];
        for (const [tab, count] of tabCounts) {
          lines.push(`  ${tab}: ${count}`);
        }

        const stamp = new Date()
          .toISOString()
          .replace("T", ".")
          .slice(0, 19);
        const outPath =
          Option.getOrUndefined(out) ?? `Paperback-Generated.${stamp}.pas5`;

        if (!apply) {
          for (const line of lines) {frameDetail(line);}
          closeFrame(`Dry-run complete. Re-run with --apply to write ${outPath}`);
          return;
        }

        const merged: Record<string, string> = {};
        if (scan.base) {
          for (const [name, records] of Object.entries(scan.base)) {
            merged[name] = JSON.stringify(records);
          }
        }
        const baseLib = scan.base?.__LIBRARY_MANGA_V5 ?? {};
        const baseSrc = scan.base?.__SOURCE_MANGA_V5 ?? {};
        const baseInfo = scan.base?.__MANGA_INFO_V5 ?? {};
        merged.__LIBRARY_MANGA_V5 = JSON.stringify({
          ...baseLib,
          ...entities.__LIBRARY_MANGA_V5,
        });
        merged.__SOURCE_MANGA_V5 = JSON.stringify({
          ...baseSrc,
          ...entities.__SOURCE_MANGA_V5,
        });
        merged.__MANGA_INFO_V5 = JSON.stringify({
          ...baseInfo,
          ...entities.__MANGA_INFO_V5,
        });

        for (const line of lines) {frameDetail(line);}
        yield* Effect.tryPromise({
          try: async () => {
            const zip = buildPas5Zip(merged);
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, zip);
            closeFrame(`Wrote ${outPath}`);
          },
          catch: (cause) =>
            new Error(errorMessage(cause)),
        });
      }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
    },
  ),
);
