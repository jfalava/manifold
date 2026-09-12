import type { JsonValue } from "@manifold/json";
import { Data, Effect, Option, Schema } from "effect";

/**
 * Encode a domain value to its wire JSON shape as an Effect.
 * Prefer this inside Effect programs.
 */
export const encodeResponseEffect = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
): Effect.Effect<S["Encoded"], Schema.SchemaError> => Schema.encodeEffect(schema)(value);

/**
 * Encode a domain value to its wire JSON shape.
 * Synchronous host boundary for HTTP handlers that are not yet Effect-native:
 * runs {@link encodeResponseEffect} via `Effect.runSync` and fails closed.
 */
export const encodeResponse = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
): S["Encoded"] => Effect.runSync(encodeResponseEffect(schema, value));

/**
 * Decode wire JSON into a domain value as an Effect.
 * Prefer this inside Effect programs. `body` is already-parsed JSON (JsonValue).
 */
export const decodeResponseEffect = <T>(
  schema: Schema.ConstraintDecoder<T>,
  body: JsonValue,
  label: string,
): Effect.Effect<T, ResponseDecodeError> =>
  Effect.gen(function* () {
    // JsonValue is structural wire data, not schema Encoded — force unknown so
    // decodeUnknown (not decode) is the typed path and preferTypedSchemaDecoder
    // does not fire a false positive.
    const untrusted: unknown = body;
    const decoded = Schema.decodeUnknownOption(schema)(untrusted);
    if (Option.isNone(decoded)) {
      return yield* new ResponseDecodeError({
        label,
        details: "schema rejected body",
      });
    }
    return decoded.value;
  });

/**
 * Decode wire JSON into a domain value.
 * Client-side host boundary: fail closed so malformed success bodies cannot
 * look like absence.
 */
export const decodeResponse = <T>(
  schema: Schema.ConstraintDecoder<T>,
  body: JsonValue,
  label: string,
): T => Effect.runSync(decodeResponseEffect(schema, body, label));

/**
 * Tagged failure for decode boundaries. Untagged `Error` loses distinction
 * in the Effect failure channel.
 */
export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  readonly label: string;
  readonly details: string;
}> {
  get message() {
    return `Response decode failed (${this.label}): ${this.details}`;
  }
}
