import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export type ClientPagination = {
  readonly pageIndex: number;
  readonly pageSize: number;
};

export type ClientPaginationControls = {
  readonly pagination: ClientPagination;
  readonly setPagination: Dispatch<SetStateAction<ClientPagination>>;
  readonly goToPage: (page: number) => void;
  readonly changePageSize: (pageSize: number) => void;
  readonly safePageIndex: (rowCount: number) => number;
};

/**
 * Controlled client pagination for TanStack Table.
 * Pair with `autoResetPageIndex: false` and clamp via `safePageIndex` so data
 * refreshes (stat merges, mutations) do not snap the page back to 0.
 */
export function useClientPagination(initialPageSize = 25): ClientPaginationControls {
  const [pagination, setPagination] = useState<ClientPagination>({
    pageIndex: 0,
    pageSize: initialPageSize,
  });

  const goToPage = useCallback((page: number) => {
    setPagination((current) => ({ ...current, pageIndex: Math.max(0, page - 1) }));
  }, []);

  const changePageSize = useCallback((pageSize: number) => {
    setPagination({ pageIndex: 0, pageSize });
  }, []);

  const safePageIndex = useCallback(
    (rowCount: number): number => {
      const maxPageIndex = Math.max(0, Math.ceil(rowCount / pagination.pageSize) - 1);
      return Math.min(pagination.pageIndex, maxPageIndex);
    },
    [pagination.pageIndex, pagination.pageSize],
  );

  return { pagination, setPagination, goToPage, changePageSize, safePageIndex };
}
