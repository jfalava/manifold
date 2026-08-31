import { Option } from "effect";

/**
 * Resolves a value with the lookup order used across this CLI:
 * explicit flag value > bare env name > ALCHEMY_SECRET_ prefixed env name
 * (the iac/.env convention).
 */
export const resolveValue = (
  flagValue: Option.Option<string>,
  ...names: readonly string[]
): string | undefined => {
  const direct = Option.getOrUndefined(flagValue);
  if (direct !== undefined) {return direct;}
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {return value;}
  }
  return undefined;
};
