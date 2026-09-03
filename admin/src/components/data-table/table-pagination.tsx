import { Pagination } from "@cloudflare/kumo";
import type { ReactNode } from "react";

import { PAGE_SIZE_OPTIONS } from "./features";

export function TablePagination({
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}: {
  /** 1-based page number (Kumo Pagination). */
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (pageSize: number) => void;
  readonly pageSizeOptions?: readonly number[];
}): ReactNode {
  return (
    <div className="flex justify-center">
      <Pagination page={page} setPage={onPageChange} perPage={pageSize} totalCount={totalCount}>
        <Pagination.Controls pageSelector="dropdown" />
        <Pagination.Separator />
        <Pagination.PageSize
          value={pageSize}
          onChange={onPageSizeChange}
          options={[...pageSizeOptions]}
          label="Per page:"
        />
      </Pagination>
    </div>
  );
}
