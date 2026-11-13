import { epochMillisNow } from "../effect-host";

export const now = (): number => epochMillisNow();

export const SYNC_DRAIN_LIMIT = 500;
export const SYNC_RETRY_DELAY_MS = 5_000;
export const SYNC_MAX_ATTEMPTS = 5;

/**
 * When a Worker-drained op may next be tried, as SQL over sync_ops. A new op
 * is due at once. After a failure the wait is four times the previous one (5 s,
 * 20 s, 80 s, 320 s), counted from updated_at, which the failure itself set.
 */
export const SYNC_OP_DUE_AT_SQL = `CASE WHEN attempts = 0 THEN 0 ELSE updated_at + (${SYNC_RETRY_DELAY_MS} << (2 * (attempts - 1))) END`;

/** Stored op errors carry titles, ids and upstream bodies; keep room for them. */
export const MAX_ERROR_LENGTH = 2_000;

/** MangaDex status shelves: one idempotent PUT per entry; small cap per alarm. */
export const MD_STATUS_DRAIN_LIMIT = 50;
export const MD_LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
