import { Badge, Banner, Button, Input, Tabs, Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { useTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  adminTableFeatures,
  DataTable,
  FilterToggle,
  TablePagination,
  useClientPagination,
  type FilterToggleVariant,
} from "../components/data-table";
import {
  loadOperations,
  retryOp,
  type ListEventItem,
  type LoadOperationsResult,
  type SyncOpItem,
} from "../lib/registry";

export const Route = createFileRoute("/operations")({
  component: OperationsPage,
});

const OPERATIONS_TABS = [
  { value: "operations", label: "Operations" },
  { value: "logs", label: "Logs" },
] as const;

type OperationsTab = (typeof OPERATIONS_TABS)[number]["value"];

const OP_STATE_BADGES = {
  completed: "success",
  pending: "warning",
  blocked: "error",
  failed: "error",
} satisfies Record<string, FilterToggleVariant>;

function variantForOpState(state: string): FilterToggleVariant {
  return Object.entries(OP_STATE_BADGES).find(([key]) => key === state)?.[1] ?? "neutral";
}

type Act = (action: () => Promise<void>) => Promise<void>;

function OperationsPage() {
  const [data, setData] = useState<LoadOperationsResult>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<OperationsTab>("operations");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setData(await loadOperations());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount syncs with the ops API; busy must flip before the await
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

  const loadErrors = data?.errors;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading">
            Sync operations
          </Text>
          <Text>Queued provider operations and the registry mutation log.</Text>
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
      {loadErrors && Object.keys(loadErrors).length > 0 && (
        <Banner variant="default" title="Partial load">
          {Object.entries(loadErrors)
            .map(([source, message]) => `${source}: ${message}`)
            .join(" · ")}
        </Banner>
      )}

      <Tabs
        variant="underline"
        tabs={[...OPERATIONS_TABS]}
        value={tab}
        onValueChange={(value) => {
          if (value === "operations" || value === "logs") {
            setTab(value);
          }
        }}
      />

      {tab === "operations" && (
        <OpsTable data={data} loading={busy && data === undefined} onAct={act} />
      )}
      {tab === "logs" && <EventsTable data={data} loading={busy && data === undefined} />}
    </div>
  );
}

// ------------------------------------------------------------------
// Operations
// ------------------------------------------------------------------

function OpsTable({
  data,
  loading,
  onAct,
}: {
  readonly data: LoadOperationsResult | undefined;
  readonly loading: boolean;
  readonly onAct: Act;
}): ReactNode {
  const [stateFilters, setStateFilters] = useState<ReadonlySet<string>>(() => new Set());
  const [sorting, setSorting] = useState<SortingState>([]);
  const { pagination, setPagination, goToPage, changePageSize, safePageIndex } =
    useClientPagination(25);

  const ops = useMemo(() => [...(data?.ops ?? [])], [data]);

  const byState = useMemo(() => {
    const counts = new Map<string, number>();
    for (const op of ops) {
      counts.set(op.state, (counts.get(op.state) ?? 0) + 1);
    }
    return counts;
  }, [ops]);

  const stateChips = useMemo(() => {
    const preferred = ["pending", "blocked", "failed", "completed"] as const;
    const known = new Set<string>(preferred);
    const present = [...byState.keys()].filter((value) => !known.has(value));
    return [...preferred.filter((value) => byState.has(value)), ...present];
  }, [byState]);

  const filtered = useMemo(() => {
    if (stateFilters.size === 0) {
      return ops;
    }
    return ops.filter((op) => stateFilters.has(op.state));
  }, [ops, stateFilters]);

  const pageIndex = safePageIndex(filtered.length);

  const toggleStateFilter = useCallback((value: string) => {
    setStateFilters((current) => {
      const next = new Set(current);
      if (!next.delete(value)) {
        next.add(value);
      }
      return next;
    });
  }, []);

  const columns = useMemo<ColumnDef<typeof adminTableFeatures, SyncOpItem>[]>(
    () => [
      { accessorKey: "id", header: "#" },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <code className="text-[0.9em]">{row.original.kind}</code>,
      },
      { accessorKey: "origin", header: "Origin" },
      {
        accessorKey: "state",
        header: "State",
        cell: ({ row }) => (
          <Badge variant={variantForOpState(row.original.state)}>{row.original.state}</Badge>
        ),
      },
      { accessorKey: "attempts", header: "Attempts" },
      {
        accessorKey: "lastError",
        header: "Error",
        cell: ({ row }) => (
          <span className="text-sm opacity-60">{row.original.lastError ?? "—"}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.state === "failed" || row.original.state === "blocked" ? (
            <Button
              size="sm"
              onClick={() =>
                void onAct(async () => {
                  await retryOp({ data: { opId: row.original.opId } });
                })
              }
            >
              Retry
            </Button>
          ) : undefined,
      },
    ],
    [onAct],
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
      <div className="grid gap-1">
        <Text as="h2" variant="heading3">
          Operations
        </Text>
        <span className="text-sm opacity-60">
          anilist:* ops wait for your device; mangadex:* drain on the Worker.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterToggle
            active={stateFilters.size === 0}
            variant="neutral"
            onClick={() => setStateFilters(new Set())}
          >
            All ({ops.length})
          </FilterToggle>
          {stateChips.map((value) => {
            const active = stateFilters.has(value);
            return (
              <FilterToggle
                key={value}
                active={active}
                variant={variantForOpState(value)}
                onClick={() => toggleStateFilter(value)}
              >
                {value} ({byState.get(value) ?? 0})
              </FilterToggle>
            );
          })}
        </div>
        <span className="text-sm opacity-60">
          Showing {filtered.length} of {ops.length}
        </span>
      </div>

      {pager}
      <DataTable table={table} emptyText="No ops recorded." loading={loading} skeletonColumns={7} />
      {pager}
    </div>
  );
}

// ------------------------------------------------------------------
// Logs (events)
// ------------------------------------------------------------------

function EventsTable({
  data,
  loading,
}: {
  readonly data: LoadOperationsResult | undefined;
  readonly loading: boolean;
}): ReactNode {
  const [filter, setFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);
  const { pagination, setPagination, goToPage, changePageSize, safePageIndex } =
    useClientPagination(25);

  const events = useMemo(() => [...(data?.events ?? [])], [data]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") {
      return events;
    }
    return events.filter((event) => {
      const detail = JSON.stringify(event.detail ?? {}).toLowerCase();
      return (
        event.entryId.toLowerCase().includes(needle) ||
        event.kind.toLowerCase().includes(needle) ||
        event.origin.toLowerCase().includes(needle) ||
        detail.includes(needle)
      );
    });
  }, [events, filter]);

  const pageIndex = safePageIndex(filtered.length);

  const columns = useMemo<ColumnDef<typeof adminTableFeatures, ListEventItem>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "When",
        cell: ({ row }) => (
          <span className="text-sm whitespace-nowrap tabular-nums">
            {new Date(row.original.createdAt).toLocaleString()}
          </span>
        ),
      },
      {
        accessorKey: "entryId",
        header: "Entry",
        cell: ({ row }) => <code className="text-xs">{row.original.entryId}</code>,
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <code className="text-[0.9em]">{row.original.kind}</code>,
      },
      { accessorKey: "origin", header: "Origin" },
      {
        id: "detail",
        header: "Detail",
        enableSorting: false,
        cell: ({ row }) => (
          <code className="text-xs opacity-60">{JSON.stringify(row.original.detail ?? {})}</code>
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
      <div className="grid gap-1">
        <Text as="h2" variant="heading3">
          Logs
        </Text>
        <span className="text-sm opacity-60">Registry mutations, newest first.</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-72"
          placeholder="Filter by entry, kind, origin, or detail"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="text-sm opacity-60">
          Showing {filtered.length} of {events.length}
        </span>
      </div>

      {pager}
      <DataTable
        table={table}
        emptyText="No events recorded."
        loading={loading}
        skeletonColumns={5}
      />
      {pager}
    </div>
  );
}
