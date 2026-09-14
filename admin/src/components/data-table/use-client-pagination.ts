/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import { isFunctionValue } from "../../lib/guards";

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

export type ClientPaginationOptions = {
  /** Use route search as the source of truth when the table is URL-backed. */
  readonly controlledPagination?: ClientPagination;
  readonly onPaginationChange?: (pagination: ClientPagination) => void;
};

function isPaginationUpdater(
  update: SetStateAction<ClientPagination>,
): update is (pagination: ClientPagination) => ClientPagination {
  return isFunctionValue(update);
}

/**
 * Controlled client pagination for TanStack Table.
 * Pair with `autoResetPageIndex: false` and clamp via `safePageIndex` so data
 * refreshes (stat merges, mutations) do not snap the page back to 0.
 */
export function useClientPagination(
  initialPageSize = 25,
  options: ClientPaginationOptions = {},
): ClientPaginationControls {
  const [localPagination, setLocalPagination] = useState<ClientPagination>({
    pageIndex: 0,
    pageSize: initialPageSize,
  });

  const pagination = options.controlledPagination ?? localPagination;
  const { controlledPagination, onPaginationChange } = options;

  const setPagination = useCallback<Dispatch<SetStateAction<ClientPagination>>>(
    (update) => {
      if (controlledPagination !== undefined) {
        const next = isPaginationUpdater(update) ? update(controlledPagination) : update;
        onPaginationChange?.(next);
        return;
      }
      setLocalPagination(update);
    },
    [controlledPagination, onPaginationChange],
  );

  const goToPage = useCallback(
    (page: number) => {
      setPagination((current) => ({ ...current, pageIndex: Math.max(0, page - 1) }));
    },
    [setPagination],
  );

  const changePageSize = useCallback(
    (pageSize: number) => {
      setPagination({ pageIndex: 0, pageSize });
    },
    [setPagination],
  );

  const safePageIndex = useCallback(
    (rowCount: number): number => {
      const maxPageIndex = Math.max(0, Math.ceil(rowCount / pagination.pageSize) - 1);
      return Math.min(pagination.pageIndex, maxPageIndex);
    },
    [pagination.pageIndex, pagination.pageSize],
  );

  return { pagination, setPagination, goToPage, changePageSize, safePageIndex };
}
