import type { JsonValue } from "@manifold/json";
import { Schema } from "effect";

/**
 * Encode a domain value to its wire JSON shape.
 * Server-side: fail closed — a SchemaError means we almost shipped garbage.
 */
export const encodeResponse = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
): S["Encoded"] => Schema.encodeSync(schema)(value);

/**
 * Decode wire JSON into a domain value.
 * Client-side: fail closed so malformed success bodies cannot look like absence.
 */
export class ResponseDecodeError extends Error {
  readonly _tag = "ResponseDecodeError";

  constructor(
    readonly label: string,
    readonly details: string,
  ) {
    super(`Response decode failed (${label}): ${details}`);
    this.name = "ResponseDecodeError";
  }
}

export const decodeResponse = <T>(
  schema: Schema.ConstraintDecoder<T>,
  body: JsonValue,
  label: string,
): T => {
  try {
    return Schema.decodeUnknownSync(schema)(body);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ResponseDecodeError(label, message);
  }
};
