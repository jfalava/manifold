import {
  useTable,
  type ColumnDef,
  type OnChangeFn,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

import type { TablePaginationSearch } from "../../lib/table-view-state";

import { adminTableFeatures, type AdminTableFeatures } from "./features";
import { TablePagination } from "./table-pagination";
import {
  useClientPagination,
  type ClientPagination,
  type ClientPaginationControls,
} from "./use-client-pagination";

const DEFAULT_PAGE_SIZE = 25;

/**
 * Pagination kept in route search params. Page 1 and the default page size are
 * written as `undefined` so they stay out of the URL; `write` maps the result
 * onto the route's (possibly prefixed) keys.
 */
export function useSearchPagination(
  search: TablePaginationSearch,
  write: (next: TablePaginationSearch) => void,
): ClientPaginationControls {
  const controlledPagination = useMemo<ClientPagination>(
    () => ({
      pageIndex: Math.max(0, (search.page ?? 1) - 1),
      pageSize: search.pageSize ?? DEFAULT_PAGE_SIZE,
    }),
    [search.page, search.pageSize],
  );

  const onPaginationChange = useCallback(
    (next: ClientPagination) =>
      write({
        page: next.pageIndex === 0 ? undefined : next.pageIndex + 1,
        pageSize: next.pageSize === DEFAULT_PAGE_SIZE ? undefined : next.pageSize,
      }),
    [write],
  );

  return useClientPagination(DEFAULT_PAGE_SIZE, { controlledPagination, onPaginationChange });
}

export interface PagedTableOptions<TData extends RowData> {
  readonly data: TData[];
  readonly columns: ColumnDef<AdminTableFeatures, TData>[];
  readonly sorting: SortingState;
  readonly onSortingChange: OnChangeFn<SortingState>;
  readonly paging: ClientPaginationControls;
  /** Rows after filtering; clamps the page and sizes the pager. */
  readonly rowCount: number;
}

/** Sorted, paginated admin table plus its pager. */
export function usePagedTable<TData extends RowData>({
  data,
  columns,
  sorting,
  onSortingChange,
  paging,
  rowCount,
}: PagedTableOptions<TData>) {
  const pageIndex = paging.safePageIndex(rowCount);

  const table = useTable({
    features: adminTableFeatures,
    data,
    columns,
    state: { sorting, pagination: { ...paging.pagination, pageIndex } },
    onSortingChange,
    onPaginationChange: paging.setPagination,
    // Refreshes and stat merges replace `data` without changing pagination
    // intent; the clamped pageIndex above stays the single source of truth.
    autoResetPageIndex: false,
  });

  const pager = (
    <TablePagination
      page={pageIndex + 1}
      pageSize={paging.pagination.pageSize}
      totalCount={rowCount}
      onPageChange={paging.goToPage}
      onPageSizeChange={paging.changePageSize}
    />
  );

  return { table, pager };
}
