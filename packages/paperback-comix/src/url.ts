/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
export const COMIX_ORIGIN = "https://comix.to";

export const resolveComixUrl = (value: string): string => {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  return `${COMIX_ORIGIN}/${trimmed.replace(/^\/+/, "")}`;
};

export const comixSearchUrl = (query: string, page: number): string =>
  `${COMIX_ORIGIN}/api/v1/manga?keyword=${encodeURIComponent(query)}&page=${page}`;
