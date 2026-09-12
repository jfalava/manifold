import { readEntry } from "./sql-helpers";
import { getAuthAccessToken } from "./auth";
import type { SyncHost } from "./host";
import { now, MD_LIBRARY_TTL_MS } from "./constants";
import { epochMillisNow } from "../effect-host";
import { Effect } from "effect";
import { manifoldUserAgent } from "@manifold/json";
import { createMangaDexClient, type MangaDexChapter, type MangaDexPaged } from "@manifold/mangadex";
import type {
  RegistryEntry,
  SetMangaDexStatusInput,
  MangaDexLibraryItem,
  MangaDexLibrarySummary,
} from "../domain";
import {
  composeMangaDexEntryStat,
  mapWithConcurrency,
  MD_STATS_CONCURRENCY,
  MD_STATS_FEED_SAMPLE,
  MD_STATS_TTL_MS,
  parseMdFeedStatsPayload,
  sampleFeedStats,
  type MangaDexEntryStat,
  type MdFeedStatsPayload,
} from "../mangadex-stats";

export async function mangaDexStats(
  host: SyncHost,
  mangaDexIds: readonly string[],
): Promise<Record<string, MangaDexEntryStat>> {
  const wanted = [...new Set(mangaDexIds)].filter((id) => id.length > 0).slice(0, 200);
  if (wanted.length === 0) {
    return {};
  }

  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });

  // 1. Feed metadata from cache, upstream sweep only for stale ids.
  const meta = new Map<string, MdFeedStatsPayload>();
  const staleIds: string[] = [];
  const cutoff = now() - MD_STATS_TTL_MS;
  for (let index = 0; index < wanted.length; index += 100) {
    const chunk = wanted.slice(index, index + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = host.ctx.storage.sql
      .exec<{ manga_id: string; payload: string; computed_at: number }>(
        `SELECT manga_id, payload, computed_at FROM md_feed_stats WHERE manga_id IN (${placeholders})`,
        ...chunk,
      )
      .toArray();
    const fresh = new Set<string>();
    for (const row of rows) {
      if (row.computed_at < cutoff) {
        continue;
      }
      const payload = parseMdFeedStatsPayload(row.payload);
      if (!payload) {
        continue;
      }
      meta.set(row.manga_id, payload);
      fresh.add(row.manga_id);
    }
    for (const mangaDexId of chunk) {
      if (!fresh.has(mangaDexId)) {
        staleIds.push(mangaDexId);
      }
    }
  }

  const fetched = new Map<string, MdFeedStatsPayload>();
  await mapWithConcurrency(staleIds, MD_STATS_CONCURRENCY, async (mangaDexId) => {
    try {
      const page = await Effect.runPromise(
        client.feedChapters(mangaDexId, { limit: MD_STATS_FEED_SAMPLE }),
      );
      fetched.set(mangaDexId, sampleFeedStats(page));
    } catch {
      // One failed lookup must not kill the batch — its cells stay "—".
    }
  });
  for (const [mangaDexId, payload] of fetched) {
    host.ctx.storage.sql.exec(
      `INSERT INTO md_feed_stats (manga_id, payload, computed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(manga_id) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at`,
      mangaDexId,
      JSON.stringify(payload),
      now(),
    );
    meta.set(mangaDexId, payload);
  }

  // 2. Fresh read markers (grouped by manga, batched 100 ids per call).
  const readMarkers = new Map<string, ReadonlySet<string>>();
  const markerFailures = new Set<string>();
  for (let index = 0; index < wanted.length; index += 100) {
    const chunk = wanted.slice(index, index + 100);
    try {
      const grouped = await Effect.runPromise(client.readMarkersBulk(chunk));
      for (const [mangaId, ids] of Object.entries(grouped)) {
        readMarkers.set(mangaId, new Set(ids));
      }
    } catch {
      for (const mangaId of chunk) {
        markerFailures.add(mangaId);
      }
    }
  }

  // 3. Compose.
  const stats: Record<string, MangaDexEntryStat> = {};
  for (const mangaDexId of wanted) {
    stats[mangaDexId] = composeMangaDexEntryStat(
      meta.get(mangaDexId),
      readMarkers.get(mangaDexId),
      markerFailures.has(mangaDexId),
    );
  }
  return stats;
}

export async function mangaDexLibrary(
  host: SyncHost,
  status?: string,
): Promise<readonly MangaDexLibraryItem[]> {
  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });
  const statusFilter =
    status === "reading" ||
    status === "on_hold" ||
    status === "plan_to_read" ||
    status === "dropped" ||
    status === "re_reading" ||
    status === "completed"
      ? status
      : undefined;

  // Helper to attach fresh ratings to a base library snapshot (statuses +
  // titles + covers). Ratings are always fetched live so the "has rating"
  // badge never goes stale inside the 24h library cache.
  const attachRatings = async (
    base: readonly MangaDexLibraryItem[],
  ): Promise<readonly MangaDexLibraryItem[]> => {
    if (base.length === 0) {
      return base;
    }
    const ids = base.map((row) => row.mangaDexId);
    try {
      const batch = await Effect.runPromise(client.getRatings(ids));
      const byId = new Map(Object.entries(batch));
      return base.map((row) =>
        byId.has(row.mangaDexId)
          ? {
              ...row,
              hasRating: true as const,
              rating: byId.get(row.mangaDexId)!.rating,
              ratingCreatedAt: byId.get(row.mangaDexId)!.createdAt,
            }
          : { ...row, hasRating: false as const },
      );
    } catch {
      // Best-effort — a single upstream failure must not kill the library.
      return base;
    }
  };

  const hydrate = async (
    statuses: Readonly<Record<string, string>>,
    options?: { readonly seed?: readonly MangaDexLibraryItem[] },
  ): Promise<readonly MangaDexLibraryItem[]> => {
    const mangaDexIds = Object.keys(statuses);
    const seedById = new Map((options?.seed ?? []).map((row) => [row.mangaDexId, row]));
    const links = new Map<string, string>();
    for (let index = 0; index < mangaDexIds.length; index += 100) {
      const chunk = mangaDexIds.slice(index, index + 100);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = host.ctx.storage.sql
        .exec<{ external_id: string; entry_id: string }>(
          `SELECT external_id, entry_id FROM provider_links
           WHERE provider = 'mangadex' AND external_id IN (${placeholders})`,
          ...chunk,
        )
        .toArray();
      for (const row of rows) {
        links.set(row.external_id, row.entry_id);
      }
    }
    // Resolve titles + covers in batches so the admin UI shows names, not bare UUIDs.
    // Prefer seed/cache rows; listManga only for ids still missing a title or cover.
    // listManga defaults to all content ratings (safe/suggestive/erotica/pornographic)
    // so adult titles never stay as “untitled” placeholders.
    const titles = new Map<string, string>();
    const covers = new Map<string, string>();
    const missingMeta: string[] = [];
    for (const mangaDexId of mangaDexIds) {
      const seeded = seedById.get(mangaDexId);
      if (seeded?.title) {
        titles.set(mangaDexId, seeded.title);
      }
      if (seeded?.coverUrl) {
        covers.set(mangaDexId, seeded.coverUrl);
      }
      if (!titles.has(mangaDexId) || !covers.has(mangaDexId)) {
        missingMeta.push(mangaDexId);
      }
    }
    for (let index = 0; index < missingMeta.length; index += 100) {
      const chunk = missingMeta.slice(index, index + 100);
      try {
        const page = await Effect.runPromise(client.listManga({ ids: chunk, limit: 100 }));
        for (const manga of page.items) {
          if (manga.title) {
            titles.set(manga.id, manga.title);
          }
          if (manga.coverUrl) {
            covers.set(manga.id, manga.coverUrl);
          }
        }
      } catch {
        // Titles are cosmetic here — a failed batch must not kill the list.
      }
    }
    const base: readonly MangaDexLibraryItem[] = mangaDexIds.map((mangaDexId) => ({
      mangaDexId,
      status: statuses[mangaDexId] ?? "",
      entryId: links.get(mangaDexId) ?? seedById.get(mangaDexId)?.entryId ?? null,
      ...(titles.has(mangaDexId) && { title: titles.get(mangaDexId) }),
      ...(covers.has(mangaDexId) && { coverUrl: covers.get(mangaDexId) }),
    }));
    return attachRatings(base);
  };

  // Status-scoped refresh: hydrate only that shelf. Reuse DO cache titles/covers
  // so listManga only runs for brand-new ids. Orphans that left the shelf are
  // reconciled in the admin IndexedDB merge (cleared to unset until Refresh all).
  if (statusFilter !== undefined) {
    const shelfStatuses = await Effect.runPromise(client.readingStatuses({ status: statusFilter }));
    const library = await hydrate(shelfStatuses, { seed: host.mdLibraryCache?.data });
    if (host.mdLibraryCache) {
      const byId = new Map(library.map((row) => [row.mangaDexId, row]));
      host.mdLibraryCache = {
        at: host.mdLibraryCache.at,
        data: host.mdLibraryCache.data.map((row) => {
          const hydrated = byId.get(row.mangaDexId);
          if (hydrated) {
            return hydrated;
          }
          if ((row.status || "") === statusFilter) {
            return { ...row, status: "" };
          }
          return row;
        }),
      };
    }
    return library;
  }

  // Serve from cache when fresh, but still refresh ratings live.
  if (host.mdLibraryCache && epochMillisNow() - host.mdLibraryCache.at < MD_LIBRARY_TTL_MS) {
    const withRatings = await attachRatings(host.mdLibraryCache.data);
    // Keep the cached snapshot in sync with the freshest ratings so a
    // subsequent cache hit without a rating fetch still reflects reality.
    if (withRatings !== host.mdLibraryCache.data) {
      host.mdLibraryCache = { at: host.mdLibraryCache.at, data: withRatings };
    }
    return withRatings;
  }

  const statuses = await Effect.runPromise(client.readingStatuses());
  const data = await hydrate(statuses);
  host.mdLibraryCache = { at: epochMillisNow(), data };
  return data;
}

export async function mangaDexLibrarySummary(host: SyncHost): Promise<MangaDexLibrarySummary> {
  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });

  // Prefer the hydrated library cache when fresh — Overview then avoids any
  // upstream round-trip beyond what a prior full load already paid.
  if (host.mdLibraryCache && epochMillisNow() - host.mdLibraryCache.at < MD_LIBRARY_TTL_MS) {
    const data = host.mdLibraryCache.data;
    const statusCounts = new Map<string, number>();
    let rated = 0;
    let ratingSum = 0;
    let linkedToRegistry = 0;
    let sawRatingFlag = false;
    for (const row of data) {
      const status = row.status === "" ? "unset" : row.status;
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      if (row.hasRating !== undefined) {
        sawRatingFlag = true;
      }
      if (row.hasRating === true && row.rating !== undefined) {
        rated += 1;
        ratingSum += row.rating;
      }
      if (row.entryId !== null) {
        linkedToRegistry += 1;
      }
    }
    if (!sawRatingFlag && data.length > 0) {
      try {
        const batch = await Effect.runPromise(client.getRatings(data.map((row) => row.mangaDexId)));
        rated = 0;
        ratingSum = 0;
        for (const entry of Object.values(batch)) {
          rated += 1;
          ratingSum += entry.rating;
        }
      } catch {
        // Best-effort ratings for overview.
      }
    }
    return {
      total: data.length,
      statuses: Object.fromEntries(statusCounts),
      rated,
      meanRating: rated > 0 ? ratingSum / rated : null,
      linkedToRegistry,
    };
  }

  const statuses = await Effect.runPromise(client.readingStatuses());
  const mangaDexIds = Object.keys(statuses);
  const statusCounts = new Map<string, number>();
  for (const status of Object.values(statuses)) {
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }

  let rated = 0;
  let ratingSum = 0;
  try {
    const batch = await Effect.runPromise(client.getRatings(mangaDexIds));
    for (const entry of Object.values(batch)) {
      rated += 1;
      ratingSum += entry.rating;
    }
  } catch {
    // Best-effort — overview still works without mean rating.
  }

  let linkedToRegistry = 0;
  for (let index = 0; index < mangaDexIds.length; index += 100) {
    const chunk = mangaDexIds.slice(index, index + 100);
    if (chunk.length === 0) {
      continue;
    }
    const placeholders = chunk.map(() => "?").join(",");
    const rows = host.ctx.storage.sql
      .exec<{ external_id: string }>(
        `SELECT external_id FROM provider_links
         WHERE provider = 'mangadex' AND external_id IN (${placeholders})`,
        ...chunk,
      )
      .toArray();
    linkedToRegistry += rows.length;
  }

  return {
    total: mangaDexIds.length,
    statuses: Object.fromEntries(statusCounts),
    rated,
    meanRating: rated > 0 ? ratingSum / rated : null,
    linkedToRegistry,
  };
}

export async function mangaDexFeed(
  host: SyncHost,
  limit: number,
  offset: number,
): Promise<MangaDexPaged<MangaDexChapter>> {
  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });
  return Effect.runPromise(client.followedFeed({ limit, offset }));
}

export async function setMangaDexStatus(
  host: SyncHost,
  mangaDexId: string,
  input: SetMangaDexStatusInput,
): Promise<void> {
  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });
  await Effect.runPromise(client.updateReadingStatus(mangaDexId, input.status));
  host.mdLibraryCache = undefined;
}

export async function entryByProvider(
  host: SyncHost,
  provider: string,
  externalId: string,
): Promise<RegistryEntry | undefined> {
  return Effect.runSync(
    Effect.sync(() => {
      const row = host.ctx.storage.sql
        .exec<{ entry_id: string }>(
          `SELECT pl.entry_id FROM provider_links pl
           JOIN canonical_entries ce ON ce.id = pl.entry_id
           WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL`,
          provider,
          externalId,
        )
        .toArray()[0];
      return row ? readEntry(host, row.entry_id, false) : undefined;
    }),
  );
}

export async function mangaDexCurrentUser(host: SyncHost): Promise<{ id: string; name?: string }> {
  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });
  return Effect.runPromise(client.currentUser);
}

export async function mangaDexReadMarkers(
  host: SyncHost,
  mangaDexId: string,
): Promise<readonly string[]> {
  const accessToken = await getAuthAccessToken(host, "mangadex");
  const client = createMangaDexClient({ accessToken, userAgent: manifoldUserAgent("api") });
  return Effect.runPromise(client.readMarkers(mangaDexId));
}
