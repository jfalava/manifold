/**
 * Client-safe types for the MangaDex library admin page. The server
 * functions live in `./registry` — keeping this module free of server
 * imports lets route components pull the constants without dragging
 * `cloudflare:workers` into the client bundle.
 */

export type MangaDexReadingStatus =
  | "reading"
  | "on_hold"
  | "plan_to_read"
  | "dropped"
  | "re_reading"
  | "completed";

// Type alias (not interface) so TanStack Table v9's `TData extends Record<string, any>` constraint accepts it
export type MangaDexLibraryItem = {
  readonly mangaDexId: string;
  readonly status: string;
  readonly entryId: string | null;
  readonly title?: string;
  readonly coverUrl?: string;
  readonly stat?: MangaDexStat;
  readonly hasRating?: boolean;
  readonly rating?: number;
  readonly ratingCreatedAt?: string;
};

/** Per-entry reading stats from POST /v1/mangadex/stats (server-computed). */
export type MangaDexStat = {
  readonly lastRead: number | null;
  readonly readChapters: number | null;
  readonly totalListed: number | null;
  readonly latestChapter: number | null;
  readonly latestDate: string | null;
  readonly percent: number | null;
};

const MANGADEX_READING_STATUSES: readonly MangaDexReadingStatus[] = [
  "reading",
  "completed",
  "dropped",
  "on_hold",
  "plan_to_read",
  "re_reading",
];

export const MANGADEX_STATUSES: readonly (MangaDexReadingStatus | "unset")[] = [
  ...MANGADEX_READING_STATUSES,
  "unset",
];

export function formatMangaDexStatus(status: string): string {
  if (!status || status === "unset") {
    return "Unset";
  }
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

const READING_STATUS_SET: ReadonlySet<string> = new Set<string>(MANGADEX_READING_STATUSES);

export const isMangaDexReadingStatus = (value: string): value is MangaDexReadingStatus =>
  READING_STATUS_SET.has(value);

/**
 * MangaDex serves a placeholder for hotlinked images — covers must load
 * through the router's /mangadex-cover proxy instead of uploads.mangadex.org.
 */
export const proxiedCoverUrl = (coverUrl: string | undefined): string | undefined => {
  if (!coverUrl) {
    return undefined;
  }
  const match = /\/covers\/([^/]+)\/([^/]+)$/.exec(coverUrl);
  if (!match) {
    return undefined;
  }
  return `/mangadex-cover/${match[1]}/${match[2]}`;
};
