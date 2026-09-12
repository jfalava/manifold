/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/**
 * Paperback's native bridge converts image fields to URL values. An empty
 * string is not a valid URL, even though the TypeScript field is required and
 * providers may legitimately have no cover.
 */
export const PAPERBACK_FALLBACK_IMAGE_URL = "https://manifold.jfa.dev/android-chrome-512x512.png";

const HTTP_IMAGE_URL = /^https?:\/\/[^\s]+$/i;

export const safeImageUrl = (value: string | undefined): string => {
  const normalized = value?.trim();
  return normalized !== undefined && HTTP_IMAGE_URL.test(normalized)
    ? normalized
    : PAPERBACK_FALLBACK_IMAGE_URL;
};
