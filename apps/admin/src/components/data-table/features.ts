import {
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * Shared admin table features (filter + sort + paginate + sizing).
 * Both registry and MangaDex use this concrete object so `DataTable` can
 * depend on one feature set instead of an open `TFeatures` generic — TanStack
 * Table v9 only exposes feature methods when the features type is concrete.
 */
export const adminTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type AdminTableFeatures = typeof adminTableFeatures;

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
