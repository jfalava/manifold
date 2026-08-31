import {
  arrayField,
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
  const candidates = uniqueTitles(isString(titles) ? [titles] : titles)
    .map(normalizeTitle)
    .filter(Boolean);
  if (candidates.length === 0) {return undefined;}
  let best: ComixSearchItem | undefined;
  let bestScore = 0;
  for (const item of items) {
    const names = [item.title, ...altTitlesOf(item)]
      .filter(isString)
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
  if (unwrapped === null) {return undefined;}
  try {
    let parsed: JsonValue = unwrapped;
    if (isString(unwrapped)) {
      // SAFETY: captured Comix JSON string is decoded via isJsonObject below
      parsed = JSON.parse(unwrapped) as JsonValue;
    }
    if (!isJsonObject(parsed)) {return undefined;}
    const result = objectField(parsed, "result");
    const items = result === undefined ? undefined : arrayField(result, "items");
    if (items === undefined) {return undefined;}
    return items.filter(isJsonObject).map(parseComixSearchItem);
  } catch {
    return undefined;
  }
};
