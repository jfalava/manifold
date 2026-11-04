/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
import { Badge, Banner, Button, Input, Tabs, Text } from "@cloudflare/kumo";
import { stringField } from "@manifold/json";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  adminTableFeatures,
  DataTable,
  FilterToggle,
  type FilterToggleVariant,
  usePagedTable,
  useSearchPagination,
} from "../components/data-table";
import {
  loadOperations,
  retryOp,
  type ListEventItem,
  type LoadOperationsResult,
  type SyncOpItem,
} from "../lib/registry";
import { parseTablePaginationSearch, type TablePaginationSearch } from "../lib/table-view-state";
import { useRefreshingLoad, type Act } from "../lib/use-load";

type OperationsSearch = {
  readonly tab?: "operations" | "logs";
  readonly opsPage?: number;
  readonly opsPageSize?: number;
  readonly logsPage?: number;
  readonly logsPageSize?: number;
};

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: TanStack Router search values are narrowed by this route boundary
function validateOperationsSearch(search: Record<string, unknown>): OperationsSearch {
  const ops = parseTablePaginationSearch(search, "ops");
  const logs = parseTablePaginationSearch(search, "logs");

  return {
    tab: search.tab === "logs" ? "logs" : undefined,
    opsPage: ops.page,
    opsPageSize: ops.pageSize,
    logsPage: logs.page,
    logsPageSize: logs.pageSize,
  };
}

export const Route = createFileRoute("/operations")({
  validateSearch: validateOperationsSearch,
  component: OperationsPage,
});

const OPERATIONS_TABS = [
  { value: "operations", label: "Errors" },
  { value: "logs", label: "Logs" },
] as const;

type OperationsTab = (typeof OPERATIONS_TABS)[number]["value"];

/** Pending ops with an error are mid-retry; label them so they read as errors. */
type OpErrorState = "retrying" | "failed" | "blocked";

const OP_ERROR_STATES = [
  "retrying",
  "failed",
  "blocked",
] as const satisfies readonly OpErrorState[];

const OP_STATE_BADGES = {
  retrying: "warning",
  blocked: "error",
  failed: "error",
} satisfies Record<OpErrorState, FilterToggleVariant>;

function errorStateForOp(op: SyncOpItem): OpErrorState {
  return op.state === "failed" || op.state === "blocked" ? op.state : "retrying";
}

function payloadEntryId(op: SyncOpItem): string | undefined {
  return stringField(op.payload, "entryId");
}

function OperationsPage() {
  const search = useSearch({ from: "/operations" });
  const navigate = useNavigate({ from: "/operations" });
  const { data, error, busy, refresh, act } = useRefreshingLoad(loadOperations);
  const tab: OperationsTab = search.tab ?? "operations";

  const handleTabChange = useCallback(
    (next: string) => {
      if (next !== "operations" && next !== "logs") {
        return;
      }

      void navigate({
        search: (current) => ({
          ...current,
          tab: next === "operations" ? undefined : next,
        }),
        resetScroll: false,
      });
    },
    [navigate],
  );

  const loadErrors = data?.errors;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading">
            Sync operations
          </Text>
          <Text>Failed provider operations and the registry mutation log.</Text>
        </div>
        <Button onClick={() => void refresh()} disabled={busy}>
          {busy ? "Working…" : "Refresh"}
        </Button>
      </div>

      {error && <Banner variant="error" title="Action failed" description={error} />}
      {loadErrors && Object.keys(loadErrors).length > 0 && (
        <Banner
          variant="alert"
          title="Partial load"
          description={Object.entries(loadErrors)
            .map(([source, message]) => `${source}: ${message}`)
            .join(" · ")}
        />
      )}

      <Tabs
        variant="underline"
        tabs={[...OPERATIONS_TABS]}
        value={tab}
        onValueChange={handleTabChange}
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
  const search = useSearch({ from: "/operations" });
  const navigate = useNavigate({ from: "/operations" });
  const [stateFilters, setStateFilters] = useState<ReadonlySet<OpErrorState>>(() => new Set());
  const [sorting, setSorting] = useState<SortingState>([{ id: "updatedAt", desc: true }]);

  const writePagination = useCallback(
    (next: TablePaginationSearch) => {
      void navigate({
        search: (current) => ({ ...current, opsPage: next.page, opsPageSize: next.pageSize }),
        resetScroll: false,
      });
    },
    [navigate],
  );

  const paging = useSearchPagination(
    { page: search.opsPage, pageSize: search.opsPageSize },
    writePagination,
  );

  const ops = useMemo(() => [...(data?.ops ?? [])], [data]);

  const byState = useMemo(() => {
    const counts = new Map<OpErrorState, number>();

    for (const op of ops) {
      const state = errorStateForOp(op);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }

    return counts;
  }, [ops]);

  const filtered = useMemo(() => {
    if (stateFilters.size === 0) {
      return ops;
    }

    return ops.filter((op) => stateFilters.has(errorStateForOp(op)));
  }, [ops, stateFilters]);

  const toggleStateFilter = useCallback((value: OpErrorState) => {
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
      {
        accessorKey: "updatedAt",
        header: "Last attempt",
        cell: ({ row }) => (
          <span className="grid gap-0.5 text-sm whitespace-nowrap tabular-nums">
            <span>{new Date(row.original.updatedAt).toLocaleString()}</span>
            <span className="text-xs opacity-60">
              queued {new Date(row.original.createdAt).toLocaleString()}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "kind",
        header: "Op",
        cell: ({ row }) => (
          <span className="grid gap-0.5">
            <code className="text-[0.9em]">{row.original.kind}</code>
            <span className="text-xs opacity-60">
              {row.original.target} · from {row.original.origin}
            </span>
          </span>
        ),
      },
      {
        id: "entry",
        header: "Entry",
        accessorFn: (op) => op.entryTitle ?? payloadEntryId(op) ?? "",
        cell: ({ row }) => {
          const entryId = payloadEntryId(row.original);

          return (
            <span className="grid gap-0.5">
              <span className="text-sm">{row.original.entryTitle ?? "—"}</span>
              {entryId !== undefined && <code className="text-xs opacity-60">{entryId}</code>}
            </span>
          );
        },
      },
      {
        id: "state",
        header: "State",
        accessorFn: errorStateForOp,
        cell: ({ row }) => {
          const state = errorStateForOp(row.original);

          return (
            <span className="grid justify-items-start gap-0.5">
              <Badge variant={OP_STATE_BADGES[state]}>{state}</Badge>
              <span className="text-xs whitespace-nowrap opacity-60">
                {row.original.attempts} attempt{row.original.attempts === 1 ? "" : "s"}
              </span>
            </span>
          );
        },
      },
      {
        accessorKey: "lastError",
        header: "Error",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="grid max-w-xl gap-1">
            <span className="text-sm break-words whitespace-pre-wrap">
              {row.original.lastError ?? "Marked failed without an error message."}
            </span>
            <details className="text-xs opacity-60">
              <summary className="cursor-pointer">Op {row.original.opId} payload</summary>
              <pre className="mt-1 break-all whitespace-pre-wrap">
                {JSON.stringify(row.original.payload, null, 2)}
              </pre>
            </details>
          </div>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
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
        ),
      },
    ],
    [onAct],
  );

  const { table, pager } = usePagedTable({
    data: filtered,
    columns,
    sorting,
    onSortingChange: setSorting,
    paging,
    rowCount: filtered.length,
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <Text as="h2" variant="heading3">
          Operation errors
        </Text>
        <span className="text-sm opacity-60">
          Ops that failed at least once. Successful ops are removed and pending ops without an error
          are hidden. anilist:* ops retry from your device; mangadex:* and mal:* retry on the
          Worker.
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
          {OP_ERROR_STATES.flatMap((value) => {
            const count = byState.get(value);

            return count === undefined
              ? []
              : [
                  <FilterToggle
                    key={value}
                    active={stateFilters.has(value)}
                    variant={OP_STATE_BADGES[value]}
                    onClick={() => toggleStateFilter(value)}
                  >
                    {value} ({count})
                  </FilterToggle>,
                ];
          })}
        </div>
        <span className="text-sm opacity-60">
          Showing {filtered.length} of {ops.length}
        </span>
      </div>

      {pager}
      <DataTable
        table={table}
        emptyText={
          data?.errors.ops === undefined ? "No operation errors." : "Ops could not be loaded."
        }
        loading={loading}
        skeletonColumns={6}
      />
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
  const search = useSearch({ from: "/operations" });
  const navigate = useNavigate({ from: "/operations" });
  const [filter, setFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);

  const writePagination = useCallback(
    (next: TablePaginationSearch) => {
      void navigate({
        search: (current) => ({ ...current, logsPage: next.page, logsPageSize: next.pageSize }),
        resetScroll: false,
      });
    },
    [navigate],
  );

  const paging = useSearchPagination(
    { page: search.logsPage, pageSize: search.logsPageSize },
    writePagination,
  );

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

  const { table, pager } = usePagedTable({
    data: filtered,
    columns,
    sorting,
    onSortingChange: setSorting,
    paging,
    rowCount: filtered.length,
  });

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
          aria-label="Filter operations and logs"
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
        emptyText={
          data?.errors.events === undefined ? "No events recorded." : "Events could not be loaded."
        }
        loading={loading}
        skeletonColumns={5}
      />
      {pager}
    </div>
  );
}
