import { Option } from "effect";

/**
 * Resolves a value with the lookup order used across this CLI:
 * explicit flag value > MANIFOLD_* env name (from cli/.env or the process).
 */
export const resolveValue = (
  flagValue: Option.Option<string>,
  ...names: readonly string[]
): string | undefined => {
  const direct = Option.getOrUndefined(flagValue);
  if (direct !== undefined) {
    return direct;
  }
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
};
