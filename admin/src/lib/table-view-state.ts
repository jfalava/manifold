/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { isNumberValue, isStringValue } from "./guards";

const TABLE_PAGE_SIZES = new Set([10, 25, 50, 100]);

export type TablePaginationSearch = {
  readonly page?: number;
  readonly pageSize?: number;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: TanStack Router search values are untrusted at the URL boundary; guards narrow them before use
function positiveInteger(value: unknown): number | undefined {
  const parsed = isNumberValue(value) ? value : isStringValue(value) ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a table's page state from TanStack Router's default search values. */
export function parseTablePaginationSearch(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: TanStack Router supplies parsed search values; this boundary parser narrows only the keys it owns
  search: Record<string, unknown>,
  prefix = "",
): TablePaginationSearch {
  const page = positiveInteger(search[prefix === "" ? "page" : `${prefix}Page`]);
  const pageSize = positiveInteger(search[prefix === "" ? "pageSize" : `${prefix}PageSize`]);
  return {
    page,
    pageSize: pageSize !== undefined && TABLE_PAGE_SIZES.has(pageSize) ? pageSize : undefined,
  };
}
