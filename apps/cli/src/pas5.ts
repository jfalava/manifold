import { buildZip, readZipText } from "@/pas5-zip";
import type { LibraryManga, MangaInfo, SourceManga } from "@/pas5-model";

export interface Pas5Entities {
  readonly __LIBRARY_MANGA_V5: Record<string, LibraryManga>;
  readonly __SOURCE_MANGA_V5: Record<string, SourceManga>;
  readonly __MANGA_INFO_V5: Record<string, MangaInfo>;
}

/** Parses a `.pas5` archive buffer into its entity records. */
export const parsePas5 = async (buf: Buffer): Promise<Pas5Entities> => {
  const files = readZipText(buf);
  // SAFETY: value matches Pas5Entities at this call site
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, JSON.parse(text)]),
  ) as Pas5Entities;
};

/** Serializes entity-file name → JSON-text map into `.pas5` bytes. */
export const buildPas5Zip = (files: Record<string, string>): Buffer =>
  buildZip(files);
