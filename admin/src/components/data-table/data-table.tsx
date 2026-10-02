/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { SkeletonLine, Table } from "@cloudflare/kumo";
import { flexRender, type ReactTable, type Row, type RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { AdminTableFeatures } from "./features";

export function DataTable<TData extends RowData>({
  table,
  emptyText,
  loading = false,
  skeletonColumns,
  renderRow,
}: {
  readonly table: ReactTable<AdminTableFeatures, TData>;
  readonly emptyText: string;
  readonly loading?: boolean;
  /** When loading, number of skeleton columns to paint (defaults to visible column count). */
  readonly skeletonColumns?: number;
  /** Optional custom row wrapper (e.g. MangaDex cover hover). */
  readonly renderRow?: (row: Row<AdminTableFeatures, TData>, cells: ReactNode) => ReactNode;
}): ReactNode {
  const columnCount = skeletonColumns ?? table.getAllColumns().length;
  const rows = table.getRowModel().rows;

  return (
    <div className="overflow-x-auto">
      <Table className="w-full">
        <Table.Header>
          {table.getHeaderGroups().map((headerGroup) => (
            <Table.Row key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sort = header.column.getIsSorted();
                const headerContent = header.isPlaceholder
                  ? undefined
                  : flexRender(header.column.columnDef.header, header.getContext());
                const sortDescription =
                  sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "not sorted";
                const ariaSort =
                  sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none";
                return (
                  <Table.Head
                    key={header.id}
                    aria-sort={canSort ? ariaSort : undefined}
                    className={canSort ? "select-none" : undefined}
                    style={{
                      width: header.getSize() !== 150 ? header.getSize() : undefined,
                    }}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 text-left"
                        aria-label={`Sort by ${String(header.column.columnDef.header)} (${sortDescription})`}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {headerContent}
                        <span aria-hidden="true" className="text-xs opacity-60">
                          {sort === "asc" ? "↑" : sort === "desc" ? "↓" : "↕"}
                        </span>
                      </button>
                    ) : (
                      headerContent
                    )}
                  </Table.Head>
                );
              })}
            </Table.Row>
          ))}
        </Table.Header>
        <Table.Body>
          {loading
            ? Array.from({ length: 6 }).map((_, index) => (
                <Table.Row key={`skeleton-${index}`}>
                  {Array.from({ length: columnCount }).map((__, cellIndex) => (
                    <Table.Cell key={`skeleton-${index}-${cellIndex}`}>
                      <SkeletonLine
                        minWidth={40}
                        maxWidth={80}
                        blockHeight={16}
                        className="rounded"
                      />
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))
            : rows.map((row) => {
                const cells = row
                  .getVisibleCells()
                  .map((cell) => (
                    <Table.Cell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Table.Cell>
                  ));
                if (renderRow) {
                  return renderRow(row, cells);
                }
                return <Table.Row key={row.id}>{cells}</Table.Row>;
              })}
          {!loading && rows.length === 0 && (
            <Table.Row>
              <Table.Cell colSpan={columnCount}>
                <span className="text-sm opacity-60">{emptyText}</span>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table>
    </div>
  );
}
