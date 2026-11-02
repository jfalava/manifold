// Typed readers for JSON and JSONL output produced by CLI subprocesses in tests.
import { existsSync, readFileSync } from "node:fs";

import {
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isJsonValue,
  isString,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";

export const parseJson = (text: string): JsonValue => {
  const value: unknown = JSON.parse(text);

  if (!isJsonValue(value)) {
    throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
  }

  return value;
};

export const asObject = (value: JsonValue | undefined, label = "value"): JsonObject => {
  if (!isJsonObject(value)) {
    throw new Error(`Expected ${label} to be a JSON object, got ${JSON.stringify(value)}`);
  }

  return value;
};

export const asArray = (value: JsonValue | undefined, label = "value"): readonly JsonValue[] => {
  if (!isJsonArray(value)) {
    throw new Error(`Expected ${label} to be a JSON array, got ${JSON.stringify(value)}`);
  }

  return value;
};

export const parseJsonObject = (text: string): JsonObject => asObject(parseJson(text), "JSON");

export const parseJsonArray = (text: string): readonly JsonValue[] =>
  asArray(parseJson(text), "JSON");

/** One JSON object per line of trimmed JSONL text. */
export const parseJsonLines = (text: string): JsonObject[] =>
  text.trim().split("\n").map(parseJsonObject);

/** JSONL report lines, or `[]` when the report file was never written. */
export const readReport = (path: string): JsonObject[] =>
  existsSync(path) ? parseJsonLines(readFileSync(path, "utf8")) : [];

export const required = <T>(value: T | null | undefined, label: string): T => {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be present`);
  }

  return value;
};

/** The first record matching `predicate`; throws when none does. */
export const findLine = (
  lines: readonly JsonObject[],
  predicate: (line: JsonObject) => boolean,
  label = "matching report line",
): JsonObject => required(lines.find(predicate), label);

export const stringAt = (record: JsonObject | undefined, key: string): string => {
  const value = record?.[key];

  if (!isString(value)) {
    throw new Error(`Expected string field "${key}", got ${JSON.stringify(value)}`);
  }

  return value;
};

export const numberAt = (record: JsonObject | undefined, key: string): number => {
  const value = record?.[key];

  if (!isFiniteNumber(value)) {
    throw new Error(`Expected number field "${key}", got ${JSON.stringify(value)}`);
  }

  return value;
};

export const objectAt = (record: JsonObject | undefined, key: string): JsonObject =>
  asObject(record?.[key], `field "${key}"`);

export const arrayAt = (record: JsonObject | undefined, key: string): readonly JsonValue[] =>
  asArray(record?.[key], `field "${key}"`);

/** An array field whose every element is a JSON object. */
export const objectsAt = (record: JsonObject | undefined, key: string): JsonObject[] =>
  arrayAt(record, key).map((item) => asObject(item, `element of "${key}"`));

/** Capture group `group` of the first match; throws when the pattern does not match. */
export const matchGroup = (text: string, pattern: RegExp, group = 1): string =>
  required(text.match(pattern)?.[group], `match for ${pattern}`);

const ESC = String.fromCharCode(27);

/** Payloads of every complete `ESC ] <code> ; payload ESC \` OSC sequence in `text`, in order. */
export const oscPayloads = (text: string, code: string): string[] => {
  const opener = `${ESC}]${code};`;

  return text
    .split(`${ESC}\\`)
    .slice(0, -1)
    .flatMap((segment) => {
      const start = segment.lastIndexOf(opener);
      const payload = segment.slice(start + opener.length);

      return start === -1 || payload.includes(ESC) ? [] : [payload];
    });
};
