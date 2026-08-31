export const COMIX_ORIGIN = "https://comix.to";

export interface ComixSearchItem {
  readonly hid?: unknown;
  readonly hash_id?: unknown;
  readonly title?: unknown;
  readonly altTitles?: unknown;
  readonly alt_titles?: unknown;
  readonly slug?: unknown;
}

export const normalizeTitle = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const tokenize = (value: string): readonly string[] =>
  normalizeTitle(value).split(" ").filter(Boolean);

// Longest-common-prefix stem match ("villains"/"villainess" share "villain"),
// mirroring the source's pickComixMatch so CLI and device agree on a title.
const tokensCompatible = (a: string, b: string): boolean => {
  if (a === b) {return true;}
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a.charCodeAt(i) === b.charCodeAt(i)) {i += 1;}
  return i >= 4;
};

export const altTitlesOf = (item: ComixSearchItem): readonly string[] => {
  const raw = item.altTitles ?? item.alt_titles;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
};

export const hidOf = (item: ComixSearchItem): string | undefined => {
  const hid = item.hid ?? item.hash_id;
  return typeof hid === "string" && hid.length > 0 ? hid : undefined;
};

export const uniqueTitles = (titles: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const title of titles) {
    const trimmed = title.trim();
    if (trimmed.length === 0) {continue;}
    const key = normalizeTitle(trimmed);
    if (key.length === 0 || seen.has(key)) {continue;}
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
};

export const pickMatch = (
  items: readonly ComixSearchItem[],
  titles: string | readonly string[],
): ComixSearchItem | undefined => {
  const candidates = uniqueTitles(typeof titles === "string" ? [titles] : titles)
    .map(normalizeTitle)
    .filter(Boolean);
  if (candidates.length === 0) {return undefined;}
  let best: ComixSearchItem | undefined;
  let bestScore = 0;
  for (const item of items) {
    const names = [item.title, ...altTitlesOf(item)]
      .filter((t): t is string => typeof t === "string")
      .map(normalizeTitle)
      .filter(Boolean);
    for (const candidate of candidates) {
      for (const name of names) {
        if (name === candidate) {return item;}
        const candidateTokens = tokenize(candidate);
        if (candidateTokens.length === 0) {continue;}
        let hits = 0;
        for (const token of candidateTokens) {
          if (name.split(" ").some((n) => tokensCompatible(n, token))) {hits += 1;}
        }
        const score = hits / candidateTokens.length;
        if (score >= 0.65 && score > bestScore) {
          best = item;
          bestScore = score;
        }
      }
    }
  }
  return best;
};

export const comixBrowseUrl = (keyword: string, page = 1): string => {
  const url = new URL("/browse", COMIX_ORIGIN);
  url.searchParams.set("page", String(page));
  url.searchParams.set("keyword", keyword);
  return url.toString();
};

export const isChallengeText = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return lowered.includes("just a moment") ||
    lowered.includes("cf-chl-") ||
    lowered.includes("challenge-platform") ||
    lowered.includes("_cf_chl_");
};

/** Unwrapped Comix capture payload (the `r` field, or the value itself). */
export type ComixCaptureBody =
  | string
  | number
  | boolean
  | null
  | readonly ComixCaptureBody[]
  | { readonly [key: string]: ComixCaptureBody };

export const unwrapComixResult = (value: unknown): ComixCaptureBody => {
  if (value !== null && typeof value === "object" && "r" in value) {
    // SAFETY: Comix inject contract wraps payload as { r }; ComixCaptureBody is the domain target.
    return (value as { r: ComixCaptureBody }).r;
  }
  // SAFETY: bare capture bodies are already domain JSON at this boundary.
  return value as ComixCaptureBody;
};

export const itemsFromCapture = (payload: unknown): readonly ComixSearchItem[] | undefined => {
  const unwrapped = unwrapComixResult(payload);
  if (unwrapped == null) {return undefined;}
  try {
    const parsed: unknown =
      // SAFETY: test/double or boundary cast through unknown to unknown
      typeof unwrapped === "string" ? (JSON.parse(unwrapped) as unknown) : unwrapped;
    if (parsed === null || typeof parsed !== "object") {return undefined;}
    // SAFETY: test/double or boundary cast through unknown to { result?: { items?: unknown } }
    const items = (parsed as { result?: { items?: unknown } }).result?.items;
    // SAFETY: value matches ComixSearchItem[] at this call site
    return Array.isArray(items) ? items as ComixSearchItem[] : undefined;
  } catch {
    return undefined;
  }
};
