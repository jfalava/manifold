import { buildZip, readZipText } from "@/pas5-zip";
import type {
  ArchivedMangaInfo,
  AttachedSource,
  LibraryManga,
  LibraryTab,
  MangaInfoReference,
  Pas5Entities,
  Pas5Unvalidated,
  SourceManga,
} from "@/pas5-model";
import {
  errorMessage,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import { toJsonText } from "@manifold/json/text";
import { Effect, Option, Schema } from "effect";
import { cliError, runHost, type CliEffectError } from "@/effect-kit";

export type { Pas5Entities } from "@/pas5-model";

/** Offline provider isolation; unlike generation, tracker-only libraries are intentional. */
export const filterPas5Providers = (
  archive: Pas5Entities,
  excludedSourceIds: ReadonlySet<string>,
): Pas5Entities => {
  const { unvalidated, ...entities } = archive;

  const sources = Object.fromEntries(
    Object.entries(archive.__SOURCE_MANGA_V5).filter(
      ([, source]) => !excludedSourceIds.has(source.sourceId),
    ),
  );

  // Unreferenced malformed sources stay unless they name an excluded provider.
  const unvalidatedSources = Object.fromEntries(
    Object.entries(unvalidated?.__SOURCE_MANGA_V5 ?? {}).filter(
      ([, source]) =>
        !isJsonObject(source) ||
        !isString(source.sourceId) ||
        !excludedSourceIds.has(source.sourceId),
    ),
  );

  const keptSourceIds = new Set([...Object.keys(sources), ...Object.keys(unvalidatedSources)]);

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

  const infoIds = new Set([
    ...Object.values(sources).map((source) => source.mangaInfo.id),
    ...Object.values(unvalidatedSources).flatMap(rawMangaInfoId),
  ]);

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
          keptSourceIds.has(chapter.sourceManga.id)
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
    ...entities,
    ...extraEntities,
    __LIBRARY_MANGA_V5: libraries,
    __SOURCE_MANGA_V5: sources,
    __MANGA_INFO_V5: Object.fromEntries(
      Object.entries(archive.__MANGA_INFO_V5).filter(([id]) => infoIds.has(id)),
    ),
    ...unvalidatedField({
      __SOURCE_MANGA_V5: unvalidatedSources,
      __MANGA_INFO_V5: Object.fromEntries(
        Object.entries(unvalidated?.__MANGA_INFO_V5 ?? {}).filter(([id]) => infoIds.has(id)),
      ),
    }),
  };
};

/** Best-effort `mangaInfo.id` of a record that failed validation. */
const rawMangaInfoId = (source: JsonValue): string[] =>
  isJsonObject(source) && isJsonObject(source.mangaInfo) && isString(source.mangaInfo.id)
    ? [source.mangaInfo.id]
    : [];

/** Omits the passthrough entirely when nothing is left, so clean archives compare equal. */
const unvalidatedField = (records: Pas5Unvalidated): Pick<Pas5Entities, "unvalidated"> =>
  Object.keys(records.__SOURCE_MANGA_V5).length + Object.keys(records.__MANGA_INFO_V5).length > 0
    ? { unvalidated: records }
    : {};

const isIdentifier = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;

const hasOptionalNumbers = (record: JsonObject, keys: readonly string[]): boolean =>
  keys.every((key) => record[key] === undefined || isFiniteNumber(record[key]));

const isAttachedSource = (value: unknown): value is AttachedSource =>
  isJsonObject(value) && isIdentifier(value.id) && value.type === "__SOURCE_MANGA_V5";

const isLibraryTab = (value: unknown): value is LibraryTab =>
  isJsonObject(value) &&
  isIdentifier(value.id) &&
  isString(value.name) &&
  isFiniteNumber(value.sortOrder);

const isLibraryManga = (value: unknown): value is LibraryManga =>
  isJsonObject(value) &&
  isIdentifier(value.id) &&
  isJsonArray(value.attachedSources) &&
  value.attachedSources.every(isAttachedSource) &&
  isJsonArray(value.libraryTabs) &&
  value.libraryTabs.every(isLibraryTab) &&
  hasOptionalNumbers(value, ["schemaVersion", "lastUpdated", "dateBookmarked", "lastRead"]);

const isMangaInfoReference = (value: unknown): value is MangaInfoReference =>
  isJsonObject(value) && isIdentifier(value.id) && value.type === "__MANGA_INFO_V5";

const isSourceManga = (value: unknown): value is SourceManga =>
  isJsonObject(value) &&
  isIdentifier(value.id) &&
  isIdentifier(value.sourceId) &&
  isIdentifier(value.mangaId) &&
  isMangaInfoReference(value.mangaInfo) &&
  hasOptionalNumbers(value, ["schemaVersion"]);

const isArchivedMangaInfo = (value: unknown): value is ArchivedMangaInfo =>
  isJsonObject(value) &&
  (value.primaryTitle === undefined || isString(value.primaryTitle)) &&
  (value.secondaryTitles === undefined || isJsonArray(value.secondaryTitles)) &&
  (value.thumbnailUrl === undefined || isString(value.thumbnailUrl)) &&
  (value.additionalInfo === undefined || isJsonObject(value.additionalInfo));

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

/**
 * Checks records in place (originals, extra fields included, go in `valid`).
 * A malformed record fails the parse when `isReferenced(id)`; otherwise it is
 * kept verbatim in `unvalidated`.
 */
const partitionRecords = <A>(
  files: JsonObject,
  name: keyof Pas5Unvalidated | "__LIBRARY_MANGA_V5",
  expected: string,
  isRecord: (value: unknown) => value is A,
  isReferenced: (id: string) => boolean,
) => {
  const valid: { [id: string]: A } = {};
  const unvalidated: { [id: string]: JsonValue } = {};

  for (const [id, record] of Object.entries(objectFile(files, name))) {
    if (isRecord(record)) {
      valid[id] = record;
    } else if (isReferenced(id)) {
      throw cliError(`Malformed PAS5 ${name} record "${id}": expected ${expected}.`);
    } else {
      unvalidated[id] = record;
    }
  }

  return { valid, unvalidated };
};

const objectFile = (files: JsonObject, name: string): JsonObject => {
  const file = files[name];

  return isJsonObject(file) ? file : {};
};

/**
 * Parses a `.pas5` archive buffer. Every entity file must be a JSON object;
 * library, source and manga-info records are checked for the fields this CLI
 * reads (absent entity files become `{}`). Unknown entity files and fields are
 * kept as-is so filters and `--base` merges write them back unchanged.
 */
const parsePas5Effect = (buf: Buffer): Effect.Effect<Pas5Entities, CliEffectError> =>
  Effect.try({
    try: () => {
      const files: Record<string, JsonObject> = {};

      for (const [name, text] of Object.entries(readZipText(buf))) {
        const value = Option.getOrThrowWith(decodeJson(text), () =>
          cliError(`PAS5 entity file ${name} is not valid JSON.`),
        );

        if (!isJsonObject(value)) {
          throw cliError(`PAS5 entity file ${name} must be a JSON object of records.`);
        }

        files[name] = value;
      }

      // Libraries are roots, so every malformed library fails the parse.
      const libraries = partitionRecords(
        files,
        "__LIBRARY_MANGA_V5",
        "id, attachedSources [{ id, type: __SOURCE_MANGA_V5 }] and libraryTabs [{ id, name, sortOrder }]",
        isLibraryManga,
        () => true,
      ).valid;

      const attachedIds = new Set(
        Object.values(libraries).flatMap((library) => library.attachedSources.map(({ id }) => id)),
      );

      const sources = partitionRecords(
        files,
        "__SOURCE_MANGA_V5",
        "id, sourceId, mangaId and mangaInfo { id, type: __MANGA_INFO_V5 }",
        isSourceManga,
        (id) => attachedIds.has(id),
      );

      const infoIds = new Set(Object.values(sources.valid).map((source) => source.mangaInfo.id));

      const infos = partitionRecords(
        files,
        "__MANGA_INFO_V5",
        "an object with string primaryTitle/thumbnailUrl, array secondaryTitles and object additionalInfo when present",
        isArchivedMangaInfo,
        (id) => infoIds.has(id),
      );

      return {
        ...files,
        __LIBRARY_MANGA_V5: libraries,
        __SOURCE_MANGA_V5: sources.valid,
        __MANGA_INFO_V5: infos.valid,
        ...unvalidatedField({
          __SOURCE_MANGA_V5: sources.unvalidated,
          __MANGA_INFO_V5: infos.unvalidated,
        }),
      };
    },
    catch: (cause) => cliError(errorMessage(cause)),
  });

export const parsePas5 = (buf: Buffer): Promise<Pas5Entities> => runHost(parsePas5Effect(buf));

/** Entity-file name → JSON text, with unvalidated passthrough records merged back into their files. */
export const pas5ArchiveFiles = (archive: Pas5Entities): Record<string, string> => {
  const { unvalidated, ...entities } = archive;

  const files = {
    ...entities,
    __SOURCE_MANGA_V5: { ...unvalidated?.__SOURCE_MANGA_V5, ...entities.__SOURCE_MANGA_V5 },
    __MANGA_INFO_V5: { ...unvalidated?.__MANGA_INFO_V5, ...entities.__MANGA_INFO_V5 },
  };

  return Object.fromEntries(
    Object.entries(files).map(([name, records]) => [name, toJsonText(records)]),
  );
};

/** Serializes entity-file name → JSON-text map into `.pas5` bytes. */
export const buildPas5Zip = (files: Record<string, string>): Buffer => buildZip(files);
