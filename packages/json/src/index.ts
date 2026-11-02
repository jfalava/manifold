/**
 * Boundary parsers for JSON-shaped values.
 * `typeof` and `unknown` parameters live only in the type predicates here.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isString(value) || isBoolean(value) || isFiniteNumber(value)) {
    return true;
  }

  if (isJsonArray(value)) {
    return value.every(isJsonValue);
  }

  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

export function stringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];

  if (!isString(value)) {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

export function numberField(record: JsonObject, key: string): number | undefined {
  const value = record[key];

  if (isFiniteNumber(value)) {
    return value;
  }

  if (!isString(value) || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

export function objectField(record: JsonObject, key: string): JsonObject | undefined {
  const value = record[key];

  return isJsonObject(value) ? value : undefined;
}

export function arrayField(record: JsonObject, key: string): readonly JsonValue[] | undefined {
  const value = record[key];

  return isJsonArray(value) ? value : undefined;
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (isString(cause)) {
    return cause;
  }

  try {
    const serialized = JSON.stringify(cause);

    return serialized === undefined ? "unknown error" : serialized;
  } catch {
    return "unknown error";
  }
}

/** What `requestHref` reads: a URL string, or anything with `href` (URL) or `url` (Request). */
type RequestHrefInput = string | { readonly href: string } | { readonly url: string };

const isRequestHrefString = (value: RequestHrefInput): value is string => typeof value === "string";

export function requestHref(input: RequestHrefInput): string {
  // Strings first: MangaDex/AniList fetchers always pass absolute URL strings.
  // Do not touch global URL/Request — Paperback's extension JSC sandbox may not
  // define them, and `instanceof URL` then throws "Can't find variable: URL"
  // (surfaced to the user as a missing-variable error on Discover boards that
  // always hit the network: Popular New Titles / Latest Updates).
  if (isRequestHrefString(input)) {
    return input;
  }

  // Duck-type the remaining Request | URL union without instanceof.
  if ("href" in input) {
    return input.href;
  }

  if ("url" in input) {
    return input.url;
  }

  throw new TypeError("requestHref: expected a string URL, URL, or Request");
}

/** The part of `Response` that Manifold HTTP clients read. Hosts without a Response constructor (Paperback) implement it directly. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export function requestInitText(init: RequestInit | undefined): string | undefined {
  const body = init?.body;

  return isString(body) ? body : undefined;
}

export {
  MANIFOLD_USER_AGENT_HOME,
  MANIFOLD_USER_AGENT_PRODUCT,
  manifoldUserAgent,
  withManifoldUserAgent,
  type ManifoldUserAgentSurface,
} from "./user-agent";

/** Trimmed, non-empty values deduplicated case-insensitively; the first spelling wins. */
export const uniqueStrings = (values: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();

    if (!normalized) {
      continue;
    }

    const key = normalized.toLocaleLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
};
