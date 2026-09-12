import type { JsonValue } from "@manifold/json";
import { Data, Effect, Option, Schema } from "effect";

/**
 * Encode a domain value to its wire JSON shape.
 * Server-side: fail closed — a SchemaError means we almost shipped garbage.
 * Runs encodeEffect synchronously at the HTTP boundary (callers are not Effect).
 */
export const encodeResponse = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
): S["Encoded"] => Effect.runSync(Schema.encodeEffect(schema)(value));

/**
 * Decode wire JSON into a domain value.
 * Client-side: fail closed so malformed success bodies cannot look like absence.
 */
export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  readonly label: string;
  readonly details: string;
}> {
  get message() {
    return `Response decode failed (${this.label}): ${this.details}`;
  }
}

export const decodeResponse = <T>(
  schema: Schema.ConstraintDecoder<T>,
  body: JsonValue,
  label: string,
): T => {
  // Wire JSON is untrusted — Encoded is not guaranteed. Prefer Option over Sync.
  // @effect-diagnostics-next-line preferTypedSchemaDecoder:off
  const decoded = Schema.decodeUnknownOption(schema)(body);
  if (Option.isNone(decoded)) {
    throw new ResponseDecodeError({
      label,
      details: "schema rejected body",
    });
  }
  return decoded.value;
};
