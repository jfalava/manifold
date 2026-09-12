import { buildZip, readZipText } from "@/pas5-zip";
import type { LibraryManga, MangaInfo, SourceManga } from "@/pas5-model";
import { isJsonObject, isString, type JsonObject } from "@manifold/json";

export interface Pas5Entities {
  readonly __LIBRARY_MANGA_V5: Record<string, LibraryManga>;
  readonly __SOURCE_MANGA_V5: Record<string, SourceManga>;
  readonly __MANGA_INFO_V5: Record<string, MangaInfo>;
}

/** Offline provider isolation; unlike generation, tracker-only libraries are intentional. */
export const filterPas5Providers = (
  archive: Pas5Entities,
  excludedSourceIds: ReadonlySet<string>,
): Pas5Entities => {
  const sources = Object.fromEntries(
    Object.entries(archive.__SOURCE_MANGA_V5).filter(
      ([, source]) => !excludedSourceIds.has(source.sourceId),
    ),
  );
  const libraries = Object.fromEntries(
    Object.entries(archive.__LIBRARY_MANGA_V5)
      .map(
        ([id, library]) =>
          [
            id,
            {
              ...library,
              attachedSources: library.attachedSources.filter((ref) =>
                Object.hasOwn(sources, ref.id),
              ),
            },
          ] as const,
      )
      .filter(([, library]) => library.attachedSources.length > 0),
  );
  const infoIds = new Set(Object.values(sources).map((source) => String(source.mangaInfo.id)));
  const extraEntities: Record<string, JsonObject> = {};
  const removedChapterIds = new Set<string>();
  // Native backups split chapters/markers across numbered entity files.
  for (const [name, records] of Object.entries(archive)) {
    if (!/^__CHAPTER_V5(?:-\d+)?$/.test(name) || !isJsonObject(records)) {
      continue;
    }
    extraEntities[name] = Object.fromEntries(
      Object.entries(records).filter(([id, chapter]) => {
        if (
          !isJsonObject(chapter) ||
          !isJsonObject(chapter.sourceManga) ||
          !isString(chapter.sourceManga.id) ||
          Object.hasOwn(sources, chapter.sourceManga.id)
        ) {
          return true;
        }
        removedChapterIds.add(id);
        if (isString(chapter.id)) {
          removedChapterIds.add(chapter.id);
        }
        return false;
      }),
    );
  }
  for (const [name, records] of Object.entries(archive)) {
    if (!/^__CHAPTER_PROGRESS_MARKER_V5(?:-\d+)?$/.test(name) || !isJsonObject(records)) {
      continue;
    }
    extraEntities[name] = Object.fromEntries(
      Object.entries(records).filter(
        ([, marker]) =>
          !isJsonObject(marker) ||
          !isJsonObject(marker.chapter) ||
          !isString(marker.chapter.id) ||
          !removedChapterIds.has(marker.chapter.id),
      ),
    );
  }
  return {
    ...archive,
    ...extraEntities,
    __LIBRARY_MANGA_V5: libraries,
    __SOURCE_MANGA_V5: sources,
    __MANGA_INFO_V5: Object.fromEntries(
      Object.entries(archive.__MANGA_INFO_V5).filter(([id]) => infoIds.has(id)),
    ),
  };
};

/** Parses a `.pas5` archive buffer into its entity records. */
export const parsePas5 = async (buf: Buffer): Promise<Pas5Entities> => {
  const files = readZipText(buf);
  // SAFETY: value matches Pas5Entities at this call site
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, JSON.parse(text)]),
  ) as Pas5Entities;
};

/** Serializes entity-file name → JSON-text map into `.pas5` bytes. */
export const buildPas5Zip = (files: Record<string, string>): Buffer => buildZip(files);
