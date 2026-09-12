import { epochMillisNow } from "../effect-host";

export const now = (): number => epochMillisNow();

export const SYNC_DRAIN_LIMIT = 500;
export const SYNC_RETRY_DELAY_MS = 5_000;
export const SYNC_MAX_ATTEMPTS = 5;
/** MangaDex status shelves: one idempotent PUT per entry; small cap per alarm. */
export const MD_STATUS_DRAIN_LIMIT = 50;
export const MD_LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;
