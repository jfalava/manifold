/**
 * JSON text through Effect Schema instead of the global `JSON` object
 * (effect diagnostic `globalJson`). A separate entry point so browser code
 * that only needs the predicates in `@manifold/json` does not bundle Schema.
 */
import { Effect, flow, Option, Schema } from "effect";

import type { JsonValue } from "./index";

const UnknownJsonText = Schema.fromJsonString(Schema.Unknown);

/**
 * JSON text for a value, through Schema rather than `JSON.stringify`.
 * Throws for values JSON cannot represent (`undefined`, BigInt, cycles),
 * where `JSON.stringify` would return `undefined` or throw.
 */
export const toJsonText = flow(Schema.encodeEffect(UnknownJsonText), Effect.runSync);

/** `toJsonText` indented by two spaces, for files people read. */
export const toPrettyJsonText = flow(
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 })),
  Effect.runSync,
);

const decodeJsonText = Schema.decodeOption(Schema.fromJsonString(Schema.Json));

/** Parses JSON text; `undefined` when the text is not valid JSON (JSON itself has no `undefined`). */
export const parseJsonText = (text: string): JsonValue | undefined =>
  Option.getOrUndefined(decodeJsonText(text));
