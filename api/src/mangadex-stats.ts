/** MangaDex stats sampling at the Worker edge. */
/** @effect-diagnostics asyncFunction:off */
import { DateTime } from "effect";
import {
  isFiniteNumber,
  isJsonObject,
  isString,
  numberField,
  objectField,
  type JsonObject,
} from "@manifold/json";

export const MD_STATS_TTL_MS = 24 * 60 * 60 * 1000;
export const MD_STATS_CONCURRENCY = 4;
export const MD_STATS_FEED_SAMPLE = 500;

export interface MdFeedChapter {
  readonly id: string;
  readonly chapterNumber?: number;
  readonly publishedAt?: number;
}

export interface MdFeedPage {
  readonly total?: number;
  readonly items: readonly MdFeedChapter[];
}

export interface MdFeedStatsPayload {
  readonly totalListed: number;
  readonly latestChapter: number | null;
  readonly latestPublishedAt: number | null;
  /** chapter id → chapter number for the sampled feed window. */
  readonly numbersById: Readonly<Record<string, string>>;
}

export interface MangaDexEntryStat {
  readonly lastRead: number | null;
  readonly readChapters: number | null;
  readonly totalListed: number | null;
  readonly latestChapter: number | null;
  readonly latestDate: string | null;
  readonly percent: number | null;
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export const sampleFeedStats = (page: MdFeedPage): MdFeedStatsPayload => {
  const newest = page.items[0];
  return {
    totalListed: page.total ?? page.items.length,
    latestChapter: newest?.chapterNumber ?? null,
    latestPublishedAt: newest?.publishedAt ?? null,
    numbersById: Object.fromEntries(
      page.items.flatMap((chapter) =>
        chapter.chapterNumber === undefined
          ? []
          : [[chapter.id, String(chapter.chapterNumber)] as const],
      ),
    ),
  };
};

const stringRecord = (value: JsonObject): Readonly<Record<string, string>> | undefined => {
  const numbersById: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isString(entry)) {
      return undefined;
    }
    numbersById[key] = entry;
  }
  return numbersById;
};

const nullableNumber = (record: JsonObject, key: string): number | null | undefined => {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return null;
  }
  return isFiniteNumber(value) ? value : undefined;
};

export const parseMdFeedStatsPayload = (text: string): MdFeedStatsPayload | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  const totalListed = numberField(parsed, "totalListed");
  const latestChapter = nullableNumber(parsed, "latestChapter");
  const latestPublishedAt = nullableNumber(parsed, "latestPublishedAt");
  const numbers = objectField(parsed, "numbersById");
  const numbersById = numbers === undefined ? undefined : stringRecord(numbers);
  if (
    totalListed === undefined ||
    latestChapter === undefined ||
    latestPublishedAt === undefined ||
    numbersById === undefined
  ) {
    return undefined;
  }
  return { totalListed, latestChapter, latestPublishedAt, numbersById };
};

export const composeMangaDexEntryStat = (
  feed: MdFeedStatsPayload | undefined,
  marks: ReadonlySet<string> | undefined,
  markerFailed: boolean,
): MangaDexEntryStat => {
  const totalListed = feed?.totalListed ?? null;
  let lastRead: number | null = null;
  let readChapters: number | null = null;
  if (!markerFailed) {
    readChapters = 0;
    if (marks !== undefined && feed !== undefined) {
      for (const chapterId of marks) {
        const numberText = feed.numbersById[chapterId];
        if (numberText === undefined) {
          continue;
        }
        readChapters += 1;
        const parsed = Number.parseFloat(numberText);
        if (Number.isFinite(parsed) && (lastRead === null || parsed > lastRead)) {
          lastRead = parsed;
        }
      }
    }
  }
  const percent =
    totalListed !== null && totalListed > 0 && readChapters !== null
      ? Math.min(100, Math.round((readChapters / totalListed) * 100))
      : null;
  return {
    lastRead,
    readChapters,
    totalListed,
    latestChapter: feed?.latestChapter ?? null,
    latestDate:
      feed?.latestPublishedAt !== undefined && feed?.latestPublishedAt !== null
        ? DateTime.formatIsoDateUtc(DateTime.makeUnsafe(feed.latestPublishedAt))
        : null,
    percent,
  };
};
