import { Schema } from "effect";

/**
 * Encode a domain value to its wire JSON shape.
 * Server-side: fail closed — a SchemaError means we almost shipped garbage.
 */
export const encodeResponse = <E>(
  schema: Schema.ConstraintEncoder<E>,
  value: unknown,
): E => Schema.encodeUnknownSync(schema)(value);

/**
 * Decode wire JSON into a domain value.
 * Client-side helper: returns undefined and logs on failure (graceful).
 */
export const decodeResponse = <T>(
  schema: Schema.ConstraintDecoder<T>,
  body: unknown,
  label: string,
): T | undefined => {
  try {
    return Schema.decodeUnknownSync(schema)(body);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[manifold/contract] decode failed:${label}:${message}`);
    return undefined;
  }
};
