import { Badge, Banner, Button, Dialog, Input, Select, Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { useTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  adminTableFeatures,
  DataTable,
  FilterToggle,
  HoverCoverRow,
  TablePagination,
  useClientPagination,
  type FilterToggleVariant,
} from "../components/data-table";
import { proxiedCoverUrl } from "../lib/mangadex";
import { readMangaDexLibraryCache } from "../lib/mangadex-idb";
import {
  bindProvider,
  loadRegistry,
  nukeEntry,
  saveChapterSource,
  saveListState,
  unlinkProvider,
  type ChapterSource,
  type RegistryEntry,
} from "../lib/registry";

export const Route = createFileRoute("/registry")({
  component: RegistryPage,
});

const STATUSES = [
  "reading",
  "on_hold",
  "plan_to_read",
  "dropped",
  "re_reading",
  "completed",
] as const;

const PROVIDERS = ["anilist", "mal", "mangadex", "comix"] as const;

const CHAPTER_SOURCES = [
  { value: "auto", label: "Auto (device heuristic)" },
  { value: "mangadex", label: "Force MangaDex" },
  { value: "comix", label: "Force Comix" },
] as const satisfies readonly { value: ChapterSource; label: string }[];

const STATUS_BADGES = {
  reading: "info",
  re_reading: "info",
  completed: "success",
  dropped: "error",
  on_hold: "warning",
  plan_to_read: "neutral",
  tombstoned: "error",
  unset: "neutral",
} satisfies Record<string, FilterToggleVariant>;

function variantForStatus(status: string): FilterToggleVariant {
  return Object.entries(STATUS_BADGES).find(([key]) => key === status)?.[1] ?? "neutral";
}

interface RegistryData {
  readonly entries: readonly RegistryEntry[];
  readonly error?: string;
}

type Act = (action: () => Promise<void>) => Promise<void>;

function RegistryPage() {
  const [data, setData] = useState<RegistryData>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setData(await loadRegistry());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount syncs with the registry API; busy must flip before the await
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      try {
        await action();
        await refresh();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading">
            Canonical registry
          </Text>
          <Text>Provider-neutral entries with tracker bindings and list state.</Text>
        </div>
        <Button onClick={() => void refresh()} disabled={busy}>
          {busy ? "Working…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <Banner variant="error" title="Action failed">
          {error}
        </Banner>
      )}
      {data?.error !== undefined && (
        <Banner variant="default" title="Partial load">
          registry: {data.error}
        </Banner>
      )}

      <EntriesTable data={data} loading={busy && data === undefined} onAct={act} />
    </div>
  );
}

// ------------------------------------------------------------------
// Entries
// ------------------------------------------------------------------

function EntryEditor({
  entry,
  onAct,
  onClose,
}: {
  readonly entry: RegistryEntry;
  readonly onAct: Act;
  readonly onClose: () => void;
}): ReactNode {
  const [provider, setProvider] = useState<string>("anilist");
  const [externalId, setExternalId] = useState("");
  const [status, setStatus] = useState(entry.state?.status ?? "");
  const [score, setScore] = useState(
    entry.state?.score !== undefined ? String(entry.state.score) : "",
  );
  const [volumeProgress, setVolumeProgress] = useState(
    entry.state?.volumeProgress !== undefined ? String(entry.state.volumeProgress) : "",
  );
  const [chapterSource, setChapterSource] = useState<ChapterSource>(
    entry.chapterSource ?? "auto",
  );
  const dead = entry.tombstoned === true;
  const chapterSourceDirty = chapterSource !== (entry.chapterSource ?? "auto");

  return (
    <div className="grid gap-5">
      <div className="grid gap-1">
        <Dialog.Title className="flex items-center gap-2">
          {entry.title}
          {dead && <Badge variant="error">tombstoned</Badge>}
        </Dialog.Title>
        <Dialog.Description className="font-mono text-[0.85em]">{entry.id}</Dialog.Description>
      </div>

      <div className="grid gap-2">
        <Text bold>List state</Text>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid flex-1 gap-1 text-sm">
            <span className="opacity-60">Status</span>
            <Select value={status} onValueChange={(value) => setStatus(String(value))}>
              <Select.Option value="">— unchanged —</Select.Option>
              {STATUSES.map((value) => (
                <Select.Option key={value} value={value}>
                  {value}
                </Select.Option>
              ))}
            </Select>
          </label>
          <label htmlFor="entry-editor-score" className="grid w-24 min-w-0 gap-1 text-sm">
            <span className="opacity-60">Score</span>
            <Input
              id="entry-editor-score"
              className="w-full min-w-0"
              value={score}
              onChange={(event) => setScore(event.target.value)}
            />
          </label>
          <label htmlFor="entry-editor-volumes" className="grid w-24 min-w-0 gap-1 text-sm">
            <span className="opacity-60">Volumes</span>
            <Input
              id="entry-editor-volumes"
              className="w-full min-w-0"
              value={volumeProgress}
              onChange={(event) => setVolumeProgress(event.target.value)}
            />
          </label>
          <Button
            disabled={
              dead || (status === "" && score.trim() === "" && volumeProgress.trim() === "")
            }
            onClick={() => {
              const payload: {
                entryId: string;
                status?: string;
                score?: number;
                volumeProgress?: number;
              } = { entryId: entry.id }; // oxlint-disable-line anti-slop/no-known-value-widening -- SAFETY: payload is intentionally widened to allow conditional optional fields; empty init is known evidence
              if (status !== "") {
                payload.status = status;
              }
              if (score.trim() !== "" && Number.isFinite(Number(score))) {
                payload.score = Number(score);
              }
              if (volumeProgress.trim() !== "" && Number.isFinite(Number(volumeProgress))) {
                payload.volumeProgress = Number(volumeProgress);
              }
              onClose();
              void onAct(async () => {
                await saveListState({
                  data: payload,
                });
              });
            }}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        <Text bold>Chapter source</Text>
        <span className="text-sm opacity-60">
          Pin which catalog the device loads for chapters. Force Comix when MangaDex
          is incomplete but still has enough chapters to skip the fallback.
        </span>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid flex-1 gap-1 text-sm">
            <span className="opacity-60">Override</span>
            <Select
              value={chapterSource}
              onValueChange={(value) => setChapterSource(String(value) as ChapterSource)}
            >
              {CHAPTER_SOURCES.map((option) => (
                <Select.Option key={option.value} value={option.value}>
                  {option.label}
                </Select.Option>
              ))}
            </Select>
          </label>
          <Button
            disabled={dead || !chapterSourceDirty}
            onClick={() => {
              onClose();
              void onAct(async () => {
                await saveChapterSource({
                  data: { entryId: entry.id, chapterSource },
                });
              });
            }}
          >
            Save source
          </Button>
        </div>
      </div>

      <div className="grid gap-2">
        <Text bold>Provider links</Text>
        <div className="grid gap-1.5">
          {entry.providers.map((link) => (
            <div key={link.provider} className="flex items-center gap-2 text-sm">
              <Badge variant="info">{link.provider}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[0.9em] opacity-70">
                {link.externalId}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void onAct(async () => {
                    await unlinkProvider({
                      data: {
                        entryId: entry.id,
                        provider: link.provider,
                      },
                    });
                  })
                }
              >
                Unlink
              </Button>
            </div>
          ))}
          {entry.providers.length === 0 && (
            <span className="text-sm opacity-40">No linked providers.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={provider} onValueChange={(value) => setProvider(String(value))}>
            {PROVIDERS.map((value) => (
              <Select.Option key={value} value={value}>
                {value}
              </Select.Option>
            ))}
          </Select>
          <Input
            className="flex-1"
            placeholder="External id"
            value={externalId}
            onChange={(event) => setExternalId(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={externalId.trim() === ""}
            onClick={() =>
              void onAct(async () => {
                await bindProvider({
                  data: {
                    entryId: entry.id,
                    provider,
                    externalId: externalId.trim(),
                  },
                });
                setExternalId("");
              })
            }
          >
            Bind
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-kumo-line pt-4">
        <Button
          variant="destructive"
          disabled={dead}
          title="Delete the AniList entry and tombstone this row"
          onClick={() => {
            onClose();
            void onAct(async () => {
              await nukeEntry({ data: { entryId: entry.id } });
            });
          }}
        >
          Nuke entry
        </Button>
        <Dialog.Close
          render={(props) => (
            <Button variant="secondary" {...props}>
              Close
            </Button>
          )}
        />
      </div>
    </div>
  );
}

function EntriesTable({
  data,
  loading,
  onAct,
}: {
  readonly data: RegistryData | undefined;
  readonly loading: boolean;
  readonly onAct: Act;
}): ReactNode {
  const [filter, setFilter] = useState("");
  const [statusFilters, setStatusFilters] = useState<ReadonlySet<string>>(() => new Set());
  // Empty set = no provider filtering (the "All" chip), matching the status filter.
  const [providerFilters, setProviderFilters] = useState<ReadonlySet<string>>(() => new Set());
  const [chapterSourceFilters, setChapterSourceFilters] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editingId, setEditingId] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const { pagination, setPagination, goToPage, changePageSize, safePageIndex } =
    useClientPagination(25);

  const entries = useMemo(() => [...(data?.entries ?? [])], [data]);

  // Covers come from the MangaDex library IndexedDB cache (populated by the
  // MangaDex library tab) — the registry itself stores no cover art, but any
  // entry with a mangadex binding can borrow the cached cover for hover zoom.
  const [coverByMangaDexId, setCoverByMangaDexId] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const { items } = await readMangaDexLibraryCache();
        if (cancelled) {
          return;
        }
        const covers = new Map<string, string>();
        for (const item of items) {
          const src = proxiedCoverUrl(item.coverUrl);
          if (src !== undefined) {
            covers.set(item.mangaDexId, src);
          }
        }
        setCoverByMangaDexId(covers);
      } catch {
        // Cache miss just means no hover covers — never block the table.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const coverForEntry = useCallback(
    (entry: RegistryEntry): string | undefined => {
      const mangaDexId = entry.providers.find((link) => link.provider === "mangadex")?.externalId;
      return mangaDexId === undefined ? undefined : coverByMangaDexId.get(mangaDexId);
    },
    [coverByMangaDexId],
  );

  // Resolve from fresh data so bind/unlink results show up while the dialog stays open.
  const editing = useMemo(
    () => entries.find((entry) => entry.id === editingId),
    [entries, editingId],
  );

  const byStatus = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.tombstoned === true ? "tombstoned" : (entry.state?.status ?? "unset");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const statusChips = useMemo(() => {
    const known = new Set<string>([...STATUSES, "tombstoned", "unset"]);
    const present = [...byStatus.keys()].filter((value) => !known.has(value));
    return [
      ...STATUSES.filter((value) => byStatus.has(value)),
      ...present,
      ...(byStatus.has("tombstoned") ? ["tombstoned"] : []),
      ...(byStatus.has("unset") ? ["unset"] : []),
    ];
  }, [byStatus]);

  // Provider chips are gap-finders: each counts the entries *missing* that
  // provider, and "unlinked" counts entries with no provider links at all.
  const missingByProvider = useMemo(() => {
    const providers = new Set<string>(PROVIDERS);
    for (const entry of entries) {
      for (const link of entry.providers) {
        providers.add(link.provider);
      }
    }
    const counts = new Map<string, number>();
    for (const provider of providers) {
      counts.set(
        provider,
        entries.filter((entry) => !entry.providers.some((link) => link.provider === provider))
          .length,
      );
    }
    counts.set("unlinked", entries.filter((entry) => entry.providers.length === 0).length);
    return counts;
  }, [entries]);

  const providerChips = useMemo(() => {
    const known = new Set<string>([...PROVIDERS, "unlinked"]);
    const present = [...missingByProvider.keys()].filter((value) => !known.has(value));
    return [...PROVIDERS, ...present, "unlinked"].filter(
      (value) => (missingByProvider.get(value) ?? 0) > 0,
    );
  }, [missingByProvider]);

  const byChapterSource = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.chapterSource ?? "auto";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return entries.filter((entry) => {
      const statusKey = entry.tombstoned === true ? "tombstoned" : (entry.state?.status ?? "unset");
      if (statusFilters.size !== 0 && !statusFilters.has(statusKey)) {
        return false;
      }
      // Each active provider chip excludes entries that *have* that provider,
      // so "comix" shows everything still missing a comix binding.
      for (const value of providerFilters) {
        if (value === "unlinked") {
          if (entry.providers.length !== 0) {
            return false;
          }
        } else if (entry.providers.some((link) => link.provider === value)) {
          return false;
        }
      }
      if (chapterSourceFilters.size !== 0) {
        const key = entry.chapterSource ?? "auto";
        if (!chapterSourceFilters.has(key)) {
          return false;
        }
      }
      if (needle === "") {
        return true;
      }
      return (
        entry.title.toLowerCase().includes(needle) ||
        entry.id.toLowerCase().includes(needle) ||
        entry.providers.some((link) => link.externalId.toLowerCase().includes(needle))
      );
    });
  }, [entries, filter, statusFilters, providerFilters, chapterSourceFilters]);

  const pageIndex = safePageIndex(filtered.length);

  const toggleStatusFilter = useCallback((value: string) => {
    setStatusFilters((current) => {
      const next = new Set(current);
      if (!next.delete(value)) {
        next.add(value);
      }
      return next;
    });
  }, []);

  const toggleProviderFilter = useCallback((value: string) => {
    setProviderFilters((current) => {
      const next = new Set(current);
      if (!next.delete(value)) {
        next.add(value);
      }
      return next;
    });
  }, []);

  const toggleChapterSourceFilter = useCallback((value: string) => {
    setChapterSourceFilters((current) => {
      const next = new Set(current);
      if (!next.delete(value)) {
        next.add(value);
      }
      return next;
    });
  }, []);

  const columns = useMemo<ColumnDef<typeof adminTableFeatures, RegistryEntry>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Title",
        cell: ({ row }) => (
          <div className="grid max-w-96 min-w-52" data-cover-zone>
            <span
              className={row.original.tombstoned ? "truncate opacity-60" : "truncate font-medium"}
            >
              {row.original.title}
            </span>
            <code className="truncate text-xs opacity-50" title={row.original.id}>
              {row.original.id}
            </code>
          </div>
        ),
      },
      {
        id: "links",
        header: "Providers",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1.5">
            {row.original.providers.map((link) => (
              <span
                key={link.provider}
                className="inline-flex max-w-56 items-baseline gap-1.5 rounded px-1.5 py-0.5 text-sm ring ring-kumo-line"
                title={`${link.provider}: ${link.externalId}`}
              >
                <span className="font-medium">{link.provider}</span>
                <span className="truncate font-mono text-[0.85em] opacity-60">
                  {link.externalId}
                </span>
              </span>
            ))}
            {row.original.providers.length === 0 && <span className="text-sm opacity-40">—</span>}
          </div>
        ),
      },
      {
        id: "chapterSource",
        accessorFn: (row) => row.chapterSource ?? "auto",
        header: "Chapters",
        cell: ({ row }) => {
          const value = row.original.chapterSource ?? "auto";
          if (value === "auto") {
            return <span className="text-sm opacity-40">auto</span>;
          }
          return (
            <Badge variant={value === "comix" ? "warning" : "info"}>{value}</Badge>
          );
        },
      },
      {
        id: "status",
        accessorFn: (row) => (row.tombstoned === true ? "tombstoned" : (row.state?.status ?? "")),
        header: "Status",
        cell: ({ row }) =>
          row.original.tombstoned === true ? (
            <Badge variant="error">tombstoned</Badge>
          ) : row.original.state?.status ? (
            <Badge variant={variantForStatus(row.original.state.status)}>
              {row.original.state.status}
            </Badge>
          ) : (
            <Badge variant="neutral">—</Badge>
          ),
      },
      {
        id: "score",
        accessorFn: (row) => row.state?.score ?? -1,
        header: "Score",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.state?.score !== undefined ? (
              row.original.state.score
            ) : (
              <span className="opacity-40">—</span>
            )}
          </span>
        ),
      },
      {
        id: "volumes",
        accessorFn: (row) => row.state?.volumeProgress ?? -1,
        header: "Volumes",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.state?.volumeProgress !== undefined ? (
              row.original.state.volumeProgress
            ) : (
              <span className="opacity-40">—</span>
            )}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditingId(row.original.id);
              setEditorOpen(true);
            }}
          >
            Edit
          </Button>
        ),
      },
    ],
    [],
  );

  // oxlint-disable-next-line react/incompatible-library -- TanStack Table's instance getters are inherently non-memoizable; the compiler already skips this component
  const table = useTable({
    features: adminTableFeatures,
    data: filtered,
    columns,
    state: { sorting, pagination: { ...pagination, pageIndex } },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    autoResetPageIndex: false,
  });

  const pager = (
    <TablePagination
      page={pageIndex + 1}
      pageSize={pagination.pageSize}
      totalCount={filtered.length}
      onPageChange={goToPage}
      onPageSizeChange={changePageSize}
    />
  );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-64"
          placeholder="Filter by title or provider id"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterToggle
            active={statusFilters.size === 0}
            variant="neutral"
            onClick={() => setStatusFilters(new Set())}
          >
            All ({entries.length})
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
                {value} ({byStatus.get(value) ?? 0})
              </FilterToggle>
            );
          })}
        </div>
        <span className="text-sm opacity-60">
          Showing {filtered.length} of {entries.length}
        </span>
      </div>

      <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
        <legend className="sr-only">Missing provider filter</legend>
        <span className="text-sm opacity-60">Missing binding:</span>
        <FilterToggle
          active={providerFilters.size === 0}
          variant="neutral"
          onClick={() => setProviderFilters(new Set())}
        >
          Off
        </FilterToggle>
        {providerChips.map((value) => {
          const active = providerFilters.has(value);
          return (
            <FilterToggle
              key={value}
              active={active}
              variant={value === "unlinked" ? "error" : "warning"}
              onClick={() => toggleProviderFilter(value)}
            >
              {value} ({missingByProvider.get(value) ?? 0})
            </FilterToggle>
          );
        })}
      </fieldset>

      <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
        <legend className="sr-only">Chapter source filter</legend>
        <span className="text-sm opacity-60">Chapter source:</span>
        <FilterToggle
          active={chapterSourceFilters.size === 0}
          variant="neutral"
          onClick={() => setChapterSourceFilters(new Set())}
        >
          All
        </FilterToggle>
        {CHAPTER_SOURCES.map((option) => {
          const count = byChapterSource.get(option.value) ?? 0;
          if (option.value === "auto" && count === 0) {
            return null;
          }
          const active = chapterSourceFilters.has(option.value);
          return (
            <FilterToggle
              key={option.value}
              active={active}
              variant={option.value === "comix" ? "warning" : "neutral"}
              onClick={() => toggleChapterSourceFilter(option.value)}
            >
              {option.value} ({count})
            </FilterToggle>
          );
        })}
      </fieldset>

      {pager}
      <DataTable
        table={table}
        emptyText="No registry entries match."
        loading={loading}
        skeletonColumns={6}
        renderRow={(row, cells) => (
          <HoverCoverRow key={row.id} src={coverForEntry(row.original)}>
            {cells}
          </HoverCoverRow>
        )}
      />
      {pager}

      <Dialog.Root open={editorOpen && editing !== undefined} onOpenChange={setEditorOpen}>
        <Dialog size="lg" className="p-6">
          {editing && (
            <EntryEditor
              key={editing.id}
              entry={editing}
              onAct={onAct}
              onClose={() => setEditorOpen(false)}
            />
          )}
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
