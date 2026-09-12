/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import {
  arrayField,
  isJsonArray,
  isJsonObject,
  isString,
  objectField,
  stringField,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";

export const COMIX_ORIGIN = "https://comix.to";

export interface ComixSearchItem {
  readonly hid?: string;
  readonly hash_id?: string;
  readonly title?: string;
  readonly altTitles?: readonly string[];
  readonly alt_titles?: readonly string[];
  readonly slug?: string;
}

export const normalizeTitle = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokenize = (value: string): readonly string[] =>
  normalizeTitle(value).split(" ").filter(Boolean);

// Longest-common-prefix stem match ("villains"/"villainess" share "villain"),
// mirroring the source's pickComixMatch so CLI and device agree on a title.
const tokensCompatible = (a: string, b: string): boolean => {
  if (a === b) {
    return true;
  }
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i >= 4;
};

export const altTitlesOf = (item: ComixSearchItem): readonly string[] =>
  item.altTitles ?? item.alt_titles ?? [];

export const hidOf = (item: ComixSearchItem): string | undefined => {
  const hid = item.hid ?? item.hash_id;
  return hid !== undefined && hid.length > 0 ? hid : undefined;
};

export const uniqueTitles = (titles: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const title of titles) {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = normalizeTitle(trimmed);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
};

export const pickMatch = (
  items: readonly ComixSearchItem[],
  titles: string | readonly string[],
): ComixSearchItem | undefined => {
  const candidates = uniqueTitles(isString(titles) ? [titles] : titles)
    .map(normalizeTitle)
    .filter(Boolean);
  if (candidates.length === 0) {
    return undefined;
  }
  let best: ComixSearchItem | undefined;
  let bestScore = 0;
  for (const item of items) {
    const names = [item.title, ...altTitlesOf(item)]
      .filter(isString)
      .map(normalizeTitle)
      .filter(Boolean);
    for (const candidate of candidates) {
      for (const name of names) {
        if (name === candidate) {
          return item;
        }
        const candidateTokens = tokenize(candidate);
        if (candidateTokens.length === 0) {
          continue;
        }
        let hits = 0;
        for (const token of candidateTokens) {
          if (name.split(" ").some((n) => tokensCompatible(n, token))) {
            hits += 1;
          }
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

// All four content ratings are pinned: the site's default filter hides
// erotica/pornographic titles, which silently turned NSFW entries into misses.
export const comixBrowseUrl = (keyword: string): string =>
  `${COMIX_ORIGIN}/browse?q=${encodeURIComponent(keyword)}&sort=relevance%3Adesc` +
  "&content_rating=safe%2Csuggestive%2Cerotica%2Cpornographic";

// udm=14 is Google's plain "Web" results view: server-rendered organic links
// without AI panels; hl=en keeps block-page detection and titles predictable.
export const googleComixSearchUrl = (keyword: string): string =>
  `https://www.google.com/search?q=${encodeURIComponent(`${keyword} site:comix.to`)}&udm=14&num=20&hl=en`;

/** True once the WebView actually shows Google results (not the previous page). */
export const isGoogleResultsUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("google.") && parsed.pathname === "/search";
  } catch {
    return false;
  }
};

const directComixUrl = (href: string): URL | undefined => {
  try {
    const url = new URL(href, "https://www.google.com");
    if (url.hostname === "www.google.com" && url.pathname === "/url") {
      const target = url.searchParams.get("q") ?? url.searchParams.get("url");
      return target === null ? undefined : directComixUrl(target);
    }
    return url.hostname === "comix.to" || url.hostname === "www.comix.to" ? url : undefined;
  } catch {
    return undefined;
  }
};

export const comixItemFromGoogleLink = (href: string, title = ""): ComixSearchItem | undefined => {
  const url = directComixUrl(href);
  if (url === undefined) {
    return undefined;
  }
  const encodedMangaId = url.pathname.match(/^\/title\/([^/]+)/)?.[1];
  if (encodedMangaId === undefined) {
    return undefined;
  }
  let mangaId: string;
  try {
    mangaId = decodeURIComponent(encodedMangaId);
  } catch {
    return undefined;
  }
  const separator = mangaId.indexOf("-");
  const hid = separator === -1 ? mangaId : mangaId.slice(0, separator);
  const slug = separator === -1 ? undefined : mangaId.slice(separator + 1);
  if (slug !== undefined && slug.length === 0) {
    return undefined;
  }
  if (!/^[a-z0-9]+$/i.test(hid)) {
    return undefined;
  }
  const resultTitle = title.trim() || slug?.replaceAll("-", " ");
  return {
    hid,
    ...(slug !== undefined && { slug }),
    ...(resultTitle !== undefined && resultTitle.length > 0 && { title: resultTitle }),
  };
};

export const addComixSearchItems = (
  target: ComixSearchItem[],
  incoming: readonly ComixSearchItem[],
): void => {
  const indexByHid = new Map<string, number>();
  for (const [index, item] of target.entries()) {
    const hid = hidOf(item);
    if (hid !== undefined) {
      indexByHid.set(hid, index);
    }
  }
  for (const item of incoming) {
    const hid = hidOf(item);
    const existingIndex = hid === undefined ? undefined : indexByHid.get(hid);
    if (existingIndex === undefined) {
      if (hid !== undefined) {
        indexByHid.set(hid, target.length);
      }
      target.push(item);
      continue;
    }
    const existing = target[existingIndex];
    if (existing === undefined) {
      continue;
    }
    const titles = uniqueTitles([
      ...altTitlesOf(existing),
      ...altTitlesOf(item),
      ...(existing.title === undefined ? [] : [existing.title]),
      ...(item.title === undefined ? [] : [item.title]),
    ]);
    target[existingIndex] = { ...item, ...existing, altTitles: titles };
  }
};

/**
 * Google's tracking redirect anchors (`/goto?url=<opaque token>`) hide the
 * target URL; the token only resolves by following the redirect in a browser.
 */
export const googleGotoLinks = (
  value: JsonValue,
): readonly { readonly href: string; readonly title: string }[] => {
  if (!isJsonArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const links: { href: string; title: string }[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const href = stringField(entry, "href");
    if (href === undefined) {
      continue;
    }
    let absolute: string;
    try {
      const url = new URL(href, "https://www.google.com");
      if (!url.hostname.includes("google.") || url.pathname !== "/goto") {
        continue;
      }
      absolute = url.toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    links.push({ href: absolute, title: (stringField(entry, "title") ?? "").trim() });
  }
  return links;
};

export const isComixPageUrl = (href: string): boolean => {
  try {
    const url = new URL(href);
    return url.hostname === "comix.to" || url.hostname === "www.comix.to";
  } catch {
    return false;
  }
};

export const itemsFromGoogleLinks = (value: JsonValue): readonly ComixSearchItem[] => {
  if (!isJsonArray(value)) {
    return [];
  }
  const items: ComixSearchItem[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const href = stringField(entry, "href");
    if (href === undefined) {
      continue;
    }
    const item = comixItemFromGoogleLink(href, stringField(entry, "title") ?? "");
    if (item !== undefined) {
      addComixSearchItems(items, [item]);
    }
  }
  return items;
};

export const isChallengeText = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return (
    lowered.includes("just a moment") ||
    lowered.includes("cf-chl-") ||
    lowered.includes("challenge-platform") ||
    lowered.includes("_cf_chl_")
  );
};

/** Google's own interstitials: /sorry captcha, consent wall, rate-limit page. */
export const isGoogleBlockedPage = (url: string, title: string): boolean => {
  const loweredUrl = url.toLowerCase();
  if (loweredUrl.includes("google.com/sorry") || loweredUrl.includes("consent.google")) {
    return true;
  }
  const loweredTitle = title.toLowerCase();
  return (
    loweredTitle.includes("before you continue") ||
    loweredTitle.includes("antes de continuar") ||
    loweredTitle.includes("unusual traffic")
  );
};

/** Unwrapped Comix capture payload (the `r` field, or the value itself). */
export type ComixCaptureBody = JsonValue;

const parseComixSearchItem = (value: JsonObject): ComixSearchItem => {
  const hid = stringField(value, "hid");
  const hash_id = stringField(value, "hash_id");
  const title = stringField(value, "title");
  const slug = stringField(value, "slug");
  const altTitles = arrayField(value, "altTitles")?.filter(isString);
  const alt_titles = arrayField(value, "alt_titles")?.filter(isString);
  return {
    ...(hid !== undefined && { hid }),
    ...(hash_id !== undefined && { hash_id }),
    ...(title !== undefined && { title }),
    ...(slug !== undefined && { slug }),
    ...(altTitles !== undefined && { altTitles }),
    ...(alt_titles !== undefined && { alt_titles }),
  };
};

export const unwrapComixResult = (value: JsonValue): JsonValue => {
  if (isJsonObject(value) && "r" in value) {
    return value.r;
  }
  return value;
};

export const itemsFromCapture = (payload: JsonValue): readonly ComixSearchItem[] | undefined => {
  const unwrapped = unwrapComixResult(payload);
  if (unwrapped === null) {
    return undefined;
  }
  try {
    let parsed: JsonValue = unwrapped;
    if (isString(unwrapped)) {
      // SAFETY: captured Comix JSON string is decoded via isJsonObject below
      parsed = JSON.parse(unwrapped) as JsonValue;
    }
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    const result = objectField(parsed, "result");
    const items = result === undefined ? undefined : arrayField(result, "items");
    if (items === undefined) {
      return undefined;
    }
    return items.filter(isJsonObject).map(parseComixSearchItem);
  } catch {
    return undefined;
  }
};
