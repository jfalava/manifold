import { Badge, Banner, Button, Select, Text } from "@cloudflare/kumo";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  adminTableFeatures,
  DataTable,
  FilterToggle,
  HoverCoverRow,
  TablePagination,
  useClientPagination,
  type FilterToggleVariant,
} from "../components/data-table";
import { MangaDexLibraryPending } from "../components/loading";
import {
  formatMangaDexStatus,
  MANGADEX_STATUSES,
  isMangaDexReadingStatus,
  proxiedCoverUrl,
  type MangaDexLibraryItem,
  type MangaDexReadingStatus,
  type MangaDexStat,
} from "../lib/mangadex";
import {
  mergeMangaDexStatusShelf,
  patchMangaDexLibraryEntry,
  readMangaDexLibraryCache,
  replaceMangaDexLibraryCache,
  type MangaDexLibrarySnapshotMeta,
} from "../lib/mangadex-idb";
import { loadMangaDexLibrary, loadMangaDexStats, setMangaDexStatus } from "../lib/registry";

export const Route = createFileRoute("/mangadex-library")({
  component: MangaDexLibraryPage,
});

const STATUS_BADGES = {
  reading: "info",
  re_reading: "info",
  completed: "success",
  dropped: "error",
  on_hold: "warning",
  plan_to_read: "neutral",
  unset: "neutral",
} satisfies Record<string, FilterToggleVariant>;

function variantForStatus(status: string): FilterToggleVariant {
  return Object.entries(STATUS_BADGES).find(([key]) => key === status)?.[1] ?? "neutral";
}

function StatusBadge({ status }: { readonly status: string }) {
  return <Badge variant={variantForStatus(status)}>{formatMangaDexStatus(status)}</Badge>;
}

function RatingBadge({
  hasRating,
  rating,
}: {
  readonly hasRating?: boolean;
  readonly rating?: number;
}) {
  if (hasRating === undefined) {
    return <span className="opacity-40">—</span>;
  }
  // Mirror StatusBadge variants: success when rated, neutral when unrated
  const variant = hasRating ? "success" : "neutral";
  const label = hasRating ? (rating !== undefined ? `Rated · ${rating}` : "Rated") : "Unrated";
  const title = hasRating && rating !== undefined ? `Rating: ${rating}/10` : undefined;
  return (
    <span title={title}>
      <Badge variant={variant}>{label}</Badge>
    </span>
  );
}

// Stats placeholder for entries the server could not compute stats for.
const EMPTY_STAT: MangaDexStat = {
  lastRead: null,
  readChapters: null,
  totalListed: null,
  latestChapter: null,
  latestDate: null,
  percent: null,
};

const formatChapterNumber = (value: number | null): string => {
  if (value === null) {
    return "—";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const formatPercent = (stat: MangaDexStat | undefined): string =>
  stat?.percent !== null && stat?.percent !== undefined ? `${stat.percent}%` : "—";

// Progress ramp: muted when barely started, kumo semantic colors as you close
// in, and a small gradient celebration at 100%.
const percentClass = (percent: number | null | undefined): string => {
  if (percent === null || percent === undefined) {
    return "";
  }
  if (percent >= 100) {
    return "bg-gradient-to-r from-fuchsia-500 via-amber-400 to-emerald-400 bg-clip-text font-semibold text-transparent";
  }
  if (percent >= 90) {
    return "font-medium text-kumo-success";
  }
  if (percent >= 60) {
    return "text-kumo-warning";
  }
  if (percent >= 25) {
    return "text-kumo-info";
  }
  return "text-kumo-subtle";
};

const formatCacheAge = (fetchedAt: number | undefined): string | undefined => {
  if (fetchedAt === undefined) {
    return undefined;
  }
  const ageMs = Date.now() - fetchedAt;
  if (ageMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
};

function MangaDexLibraryPage() {
  const [items, setItems] = useState<readonly MangaDexLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [savingId, setSavingId] = useState<string | undefined>(undefined);
  const [statusFilters, setStatusFilters] = useState<ReadonlySet<string>>(() => new Set());
  const [ratingFilter, setRatingFilter] = useState<"all" | "rated" | "unrated">("all");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [stats, setStats] = useState<Record<string, MangaDexStat>>({});
  const [cacheMeta, setCacheMeta] = useState<MangaDexLibrarySnapshotMeta | undefined>(undefined);
  const [refreshingStatus, setRefreshingStatus] = useState<MangaDexReadingStatus | undefined>(
    undefined,
  );
  const { pagination, setPagination, goToPage, changePageSize, safePageIndex } =
    useClientPagination(25);
  const inflightStats = useRef<Set<string>>(new Set());
  const bootstrapped = useRef(false);

  const refreshAll = useCallback(async () => {
    setSyncing(true);
    setError(undefined);
    try {
      const library = await loadMangaDexLibrary({ data: {} });
      const meta = await replaceMangaDexLibraryCache(library);
      setItems(library);
      setCacheMeta(meta);
      setNotice(`Cached ${library.length} titles from MangaDex.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }, []);

  const refreshStatus = useCallback(async (status: MangaDexReadingStatus) => {
    setRefreshingStatus(status);
    setError(undefined);
    try {
      const shelf = await loadMangaDexLibrary({ data: { status } });
      const next = await mergeMangaDexStatusShelf(status, shelf);
      setItems(next);
      setCacheMeta({ fetchedAt: Date.now(), count: next.length });
      setNotice(`Refetched ${formatMangaDexStatus(status)} (${shelf.length} on shelf).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshingStatus(undefined);
    }
  }, []);

  useEffect(() => {
    if (bootstrapped.current) {
      return;
    }
    bootstrapped.current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- hydrate from IndexedDB, network only when empty
    void (async () => {
      try {
        const cached = await readMangaDexLibraryCache();
        if (cached.items.length > 0) {
          setItems(cached.items);
          setCacheMeta(cached.meta);
          setLoading(false);
          return;
        }
      } catch {
        // IndexedDB unavailable — fall through to network.
      }
      await refreshAll();
    })();
  }, [refreshAll]);

  const changeStatus = useCallback(async (item: MangaDexLibraryItem, next: string) => {
    const isUnset = next === "" || next === "unset";
    if (!isUnset && !isMangaDexReadingStatus(next)) {
      return;
    }
    setSavingId(item.mangaDexId);
    setError(undefined);
    setNotice(undefined);
    try {
      await setMangaDexStatus({
        data: {
          mangaDexId: item.mangaDexId,
          status: isUnset ? "unset" : next,
        },
      });
      const nextStatus = isUnset ? "" : next;
      setItems((current) =>
        current.map((row) =>
          // keep empty-string for unset to match server shape
          row.mangaDexId === item.mangaDexId ? { ...row, status: nextStatus } : row,
        ),
      );
      void patchMangaDexLibraryEntry(item.mangaDexId, { status: nextStatus });
      setNotice(
        `${item.title ?? item.mangaDexId} → ${formatMangaDexStatus(isUnset ? "unset" : next)}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingId(undefined);
    }
  }, []);

  const toggleStatusFilter = useCallback((value: string) => {
    setStatusFilters((current) => {
      const next = new Set(current);
      if (!next.delete(value)) {
        next.add(value);
      }
      return next;
    });
  }, []);

  // Enrich items with the fetched stats so column accessors stay plain reads.
  const enrichedItems = useMemo(
    () =>
      items.map((item) => {
        const stat = stats[item.mangaDexId];
        return stat === undefined ? item : { ...item, stat };
      }),
    [items, stats],
  );

  const filtered = useMemo(() => {
    let result = enrichedItems;
    if (statusFilters.size !== 0) {
      result = result.filter((item) => statusFilters.has(item.status || "unset"));
    }
    if (ratingFilter !== "all") {
      result = result.filter((item) =>
        ratingFilter === "rated" ? item.hasRating === true : item.hasRating === false,
      );
    }
    return result;
  }, [enrichedItems, ratingFilter, statusFilters]);

  const columns = useMemo<ColumnDef<typeof adminTableFeatures, MangaDexLibraryItem>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Title",
        cell: ({ row }) => (
          <div className="flex max-w-96 min-w-0 flex-col gap-0.5" data-cover-zone>
            <a
              href={`https://mangadex.org/title/${row.original.mangaDexId}`}
              target="_blank"
              rel="noreferrer"
              className="truncate font-medium hover:underline"
            >
              {row.original.title ?? "(untitled)"}
            </a>
            <span className="truncate font-mono text-[0.9em] opacity-60">
              {row.original.mangaDexId}
            </span>
          </div>
        ),
      },
      {
        id: "lastRead",
        header: "Last read",
        accessorFn: (row) => row.stat?.lastRead ?? -1,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatChapterNumber(row.original.stat?.lastRead ?? null)}
          </span>
        ),
      },
      {
        id: "latest",
        header: "Latest",
        accessorFn: (row) => row.stat?.latestDate ?? "",
        cell: ({ row }) => {
          const stat = row.original.stat;
          if (stat?.latestChapter === null && stat?.latestDate === null) {
            return <span className="opacity-40">—</span>;
          }
          return (
            <span className="whitespace-nowrap tabular-nums">
              {formatChapterNumber(stat?.latestChapter ?? null)}
              {stat?.latestDate !== null && stat?.latestDate !== undefined && (
                <span className="ml-1.5 font-mono text-[0.85em] opacity-60">{stat.latestDate}</span>
              )}
            </span>
          );
        },
      },
      {
        id: "progress",
        header: "Caught up",
        accessorFn: (row) => row.stat?.percent ?? -1,
        cell: ({ row }) => {
          const stat = row.original.stat;
          const tooltip =
            stat?.readChapters !== null &&
            stat?.readChapters !== undefined &&
            stat?.totalListed !== null &&
            stat?.totalListed !== undefined
              ? `${stat.readChapters} read of ${stat.totalListed} listed`
              : undefined;
          return (
            <span title={tooltip} className={`tabular-nums ${percentClass(stat?.percent)}`}>
              {formatPercent(stat)}
            </span>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Current status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "rating",
        header: "Rated",
        accessorFn: (row) =>
          row.hasRating === undefined ? -1 : row.hasRating ? (row.rating ?? 10) : -2,
        cell: ({ row }) => (
          <RatingBadge hasRating={row.original.hasRating} rating={row.original.rating} />
        ),
        sortingFn: "basic",
      },
      {
        id: "actions",
        header: "Change to",
        enableSorting: false,
        cell: ({ row }) => (
          <Select
            value={row.original.status || "unset"}
            disabled={savingId === row.original.mangaDexId}
            onValueChange={(value) => void changeStatus(row.original, String(value))}
            renderValue={(value) => formatMangaDexStatus(value)}
          >
            {MANGADEX_STATUSES.map((value) => (
              <Select.Option key={value} value={value}>
                {formatMangaDexStatus(value)}
              </Select.Option>
            ))}
          </Select>
        ),
      },
    ],
    [changeStatus, savingId],
  );

  // TanStack Table requires a referentially stable `data` array — an inline
  // spread re-identifies every render and the pagination auto-reset loops
  // forever (hard tab freeze on first interaction).
  const data = useMemo(() => [...filtered], [filtered]);

  // A filter or page-size change can strand the stored page index past the
  // last page — derive a clamped index instead of correcting state in an effect.
  const pageIndex = safePageIndex(filtered.length);

  const pagedData = useMemo(
    () => data.slice(pageIndex * pagination.pageSize, (pageIndex + 1) * pagination.pageSize),
    [data, pageIndex, pagination.pageSize],
  );

  // Fetch reading stats lazily for just this page's rows; results merge into
  // `stats`, and ids the server could not resolve get EMPTY_STAT so we never
  // retry them in a loop.
  useEffect(() => {
    if (loading || pagedData.length === 0) {
      return undefined;
    }
    const missing = pagedData
      .map((item) => item.mangaDexId)
      .filter((id) => !(id in stats) && !inflightStats.current.has(id));
    if (missing.length === 0) {
      return undefined;
    }
    for (const id of missing) {
      inflightStats.current.add(id);
    }
    void loadMangaDexStats({ data: { ids: missing } })
      .then((result) => {
        setStats((current) => {
          const next = { ...current };
          for (const id of missing) {
            next[id] = result[id] ?? EMPTY_STAT;
          }
          return next;
        });
        return undefined;
      })
      .catch(() => {
        setStats((current) => {
          const next = { ...current };
          for (const id of missing) {
            next[id] = EMPTY_STAT;
          }
          return next;
        });
      })
      .finally(() => {
        for (const id of missing) {
          inflightStats.current.delete(id);
        }
      });
    return undefined;
    // oxlint-disable-next-line react/set-state-in-effect -- lazy page-slice fetch mirrors the refresh-on-mount pattern above
  }, [loading, pagedData, stats]);

  // TanStack Table's instance getters are inherently non-memoizable; the compiler already skips this component
  // oxlint-disable-next-line react/incompatible-library
  const table = useTable({
    features: adminTableFeatures,
    data,
    columns,
    state: { sorting, pagination: { ...pagination, pageIndex } },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    // Lazy stat enrichment and status mutations replace `data` references
    // without changing pagination intent — disable TanStack's default
    // auto-reset (core/sorted models call `table_autoResetPageIndex` on
    // every `data` reference change) and keep the externally-controlled
    // pageIndex clamping as the single source of truth.
    autoResetPageIndex: false,
  });

  const byStatus = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = item.status || "unset";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const byRating = useMemo(() => {
    let rated = 0;
    let unrated = 0;
    let unknown = 0;
    for (const item of items) {
      if (item.hasRating === true) {
        rated += 1;
      } else if (item.hasRating === false) {
        unrated += 1;
      } else {
        unknown += 1;
      }
    }
    return { rated, unrated, unknown };
  }, [items]);

  // One filter chip per current status: canonical MangaDex statuses first,
  // then anything unexpected the library contains, then "unset" last.
  const statusChips = useMemo(() => {
    const known = new Set<string>(MANGADEX_STATUSES);
    const present = [...byStatus.keys()].filter((value) => !known.has(value));
    return [
      ...MANGADEX_STATUSES.filter((value) => byStatus.has(value)),
      ...present,
      ...(byStatus.has("unset") ? [] : ["unset"]),
    ];
  }, [byStatus]);

  const pager = (
    <TablePagination
      page={pageIndex + 1}
      pageSize={pagination.pageSize}
      totalCount={filtered.length}
      onPageChange={goToPage}
      onPageSizeChange={changePageSize}
    />
  );

  if (loading && items.length === 0) {
    return <MangaDexLibraryPending />;
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          MangaDex library
        </Text>
        <Text>
          {items.length} followed titles cached locally
          {formatCacheAge(cacheMeta?.fetchedAt) !== undefined
            ? ` (snapshot ${formatCacheAge(cacheMeta?.fetchedAt)})`
            : ""}
          . Status edits hit MangaDex immediately; use Refresh all or Refetch shelf for remote
          resync.
        </Text>
      </div>

      {error !== undefined && (
        <Banner
          variant="error"
          title={
            error.includes("not connected") || error.includes("reauthorization")
              ? "MangaDex not connected"
              : "Action failed"
          }
          description={error}
        />
      )}
      {error !== undefined &&
        (error.includes("not connected") || error.includes("reauthorization")) && (
          <p className="text-sm">
            <Link to="/credentials" className="underline opacity-80 hover:opacity-100">
              Open Credentials → connect from deployment secrets
            </Link>
          </p>
        )}
      {notice !== undefined && (
        <Banner variant="default" title="Library updated">
          {notice}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void refreshAll()} disabled={loading || syncing}>
          {syncing ? "Refreshing…" : "Refresh all"}
        </Button>
        {statusFilters.size === 1 &&
          [...statusFilters].every((value) => isMangaDexReadingStatus(value)) && (
            <Button
              onClick={() => {
                const [only] = [...statusFilters];
                if (only !== undefined && isMangaDexReadingStatus(only)) {
                  void refreshStatus(only);
                }
              }}
              disabled={loading || syncing || refreshingStatus !== undefined}
            >
              {refreshingStatus !== undefined
                ? `Refetching ${formatMangaDexStatus(refreshingStatus)}…`
                : `Refetch ${formatMangaDexStatus([...statusFilters][0] ?? "")}`}
            </Button>
          )}
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterToggle
            active={statusFilters.size === 0}
            variant="neutral"
            onClick={() => setStatusFilters(new Set())}
          >
            All ({items.length})
          </FilterToggle>
          {statusChips.map((value) => {
            const active = statusFilters.has(value);
            return (
              <FilterToggle
                key={value}
                active={active}
                variant={variantForStatus(value)}
                onClick={() => toggleStatusFilter(value)}
              >
                {formatMangaDexStatus(value)} ({byStatus.get(value) ?? 0})
                {refreshingStatus === value ? "…" : ""}
              </FilterToggle>
            );
          })}
        </div>
        <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">Rating filter</legend>
          <FilterToggle
            active={ratingFilter === "all"}
            variant="neutral"
            onClick={() => setRatingFilter("all")}
          >
            Any rating ({items.length})
          </FilterToggle>
          <FilterToggle
            active={ratingFilter === "rated"}
            variant="success"
            onClick={() => setRatingFilter((current) => (current === "rated" ? "all" : "rated"))}
          >
            Rated ({byRating.rated})
          </FilterToggle>
          <FilterToggle
            active={ratingFilter === "unrated"}
            variant="neutral"
            onClick={() =>
              setRatingFilter((current) => (current === "unrated" ? "all" : "unrated"))
            }
          >
            Unrated ({byRating.unrated}
            {byRating.unknown > 0 ? ` + ${byRating.unknown} unknown` : ""})
          </FilterToggle>
        </fieldset>
        <span className="text-sm opacity-60">
          Showing {filtered.length} of {items.length}
        </span>
      </div>

      {/* Duplicated pager: right below the filters and again at the bottom */}
      {pager}

      <DataTable
        table={table}
        emptyText="No titles match this filter."
        loading={loading}
        skeletonColumns={7}
        renderRow={(row, cells) => (
          <HoverCoverRow key={row.id} src={proxiedCoverUrl(row.original.coverUrl)}>
            {cells}
          </HoverCoverRow>
        )}
      />

      {pager}
    </div>
  );
}
