/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
/**
 * Centralized boundary parsers for untrusted payloads.
 * These are the only places where `typeof` and `unknown` are sanctioned;
 * all other code must use these helpers and branch on domain values.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: boundary parser for any JSON object; validates shape before downstream use
export function isJsonObject(value: unknown): value is JsonObject {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: central object guard, single source of typeof for records
  return typeof value === "object" && value !== null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: boundary parser for JSON values; validates shape before downstream use
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isStringValue(value) || isNumberValue(value)) {
    return true;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: central boolean guard for JSON
  if (typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: boundary helper for string at I/O edge
export function isStringValue(value: unknown): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: central string guard
  return typeof value === "string";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: boundary helper for number at I/O edge
export function isNumberValue(value: unknown): value is number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: central number guard
  return typeof value === "number";
}

export interface SecretHandle {
  readonly get?: () => Promise<string | null>;
  readonly value?: string;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: helper for secret bindings that may be string or handle
export function isSecretHandleObject(value: unknown): value is SecretHandle {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: object check for secret handle
  return typeof value === "object" && value !== null;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: generic function check, covers any callable at the central boundary */
export function isFunctionValue(value: unknown): value is (...args: never[]) => unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: central function guard
  return typeof value === "function";
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
