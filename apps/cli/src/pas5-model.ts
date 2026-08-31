/**
 * Paperback backup archive (`*.pas5`) entity model, derived from a real
 * device export (see `paperback-backup-example/` in the repo root).
 */

/** Core Data reference date: seconds since 2001-01-01. */
export const coreDataNow = (): number => Date.now() / 1000 - 978_307_200;

export const coreDataFromUnix = (unixSeconds: number): number =>
  unixSeconds - 978_307_200;

/** "Never read" sentinel used by device exports for `lastRead`. */
export const LAST_READ_NEVER = -63_114_076_800;

/**
 * Deterministic signed-int64 key for `__MANGA_INFO_V5`, hashed from the
 * source binding so re-runs produce identical keys.
 */
export const mangaInfoKey = (sourceId: string, mangaId: string): string => {
  let hash = 0xcbf29ce484222325n;
  const input = `${sourceId}|${mangaId}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return BigInt.asIntN(64, hash).toString();
};

/** Stable UUIDv4-shaped id derived from a seed (re-runs stay mergeable). */
export const deterministicUuid = (seed: string): string => {
  const digest = new Uint8Array(16);
  let h1 = 0x811c9dc5n;
  let h2 = 0x1003fn | 0n;
  for (let i = 0; i < seed.length; i++) {
    const c = BigInt(seed.charCodeAt(i));
    h1 = ((h1 ^ c) * 0x100000001b3n) & 0xffffffffffffffffn;
    h2 = ((h2 * 31n + c) * 0x2545f491n) & 0xffffffffffffffffn;
  }
  const view = new DataView(digest.buffer);
  view.setBigUint64(0, h1);
  view.setBigUint64(8, h2);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
};

export interface AttachedSource {
  readonly id: string;
  readonly type: "__SOURCE_MANGA_V5";
}

export interface LibraryTab {
  readonly name: string;
  readonly sortOrder: number;
  readonly id: string;
}

export interface LibraryManga {
  readonly schemaVersion: 1;
  readonly attachedSources: readonly AttachedSource[];
  readonly lastUpdated: number;
  readonly dateBookmarked: number;
  readonly lastRead: number;
  readonly id: string;
  readonly libraryTabs: readonly LibraryTab[];
}

export interface SourceManga {
  readonly id: string;
  readonly sourceId: string;
  readonly schemaVersion: 1;
  readonly mangaId: string;
  readonly mangaInfo: { readonly id: string; readonly type: "__MANGA_INFO_V5" };
}

export interface MangaInfo {
  /** Required by Paperback's decoder — emit "" when unknown. */
  readonly synopsis: string;
  readonly status: "FINISHED" | "RELEASING";
  readonly contentType: "comic";
  readonly tagGroups: readonly unknown[];
  readonly additionalInfo: Record<string, string>;
  readonly schemaVersion: 1;
  readonly primaryTitle: string;
  readonly artworkUrls: readonly string[];
  readonly thumbnailUrl: string;
  readonly contentRating: "SAFE";
  readonly rating: number;
  readonly secondaryTitles: readonly string[];
}

export interface Pas5Entities {
  readonly __LIBRARY_MANGA_V5: Record<string, LibraryManga>;
  readonly __SOURCE_MANGA_V5: Record<string, SourceManga>;
  readonly __MANGA_INFO_V5: Record<string, MangaInfo>;
}

/** AniList list status → Paperback tab name, in stable display order. */
export const TAB_ORDER: readonly string[] = [
  "Reading",
  "Paused",
  "Dropped",
  "Completed",
  "Planning",
];

const STATUS_TO_TAB: Record<string, string> = {
  CURRENT: "Reading",
  REPEATING: "Reading",
  PAUSED: "Paused",
  DROPPED: "Dropped",
  COMPLETED: "Completed",
  PLANNING: "Planning",
};

export const tabForStatus = (status: string): string | undefined =>
  STATUS_TO_TAB[status];

/** AniList media status → Paperback MangaInfo status (unknown → RELEASING). */
export const infoStatusFor = (
  mediaStatus: string | undefined,
): "FINISHED" | "RELEASING" =>
  mediaStatus === "FINISHED" ? "FINISHED" : "RELEASING";
