/** CF Secrets Store .get() host boundary. */
/** @effect-diagnostics asyncFunction:off */
import { isString } from "@manifold/json";
import type { SecretsStoreSecret } from "@cloudflare/workers-types";

type SecretBindingValue = string | SecretsStoreSecret | undefined;

const secretBinding = (value: SecretBindingValue): value is SecretsStoreSecret =>
  typeof value === "object" && value !== null && typeof value.get === "function";

/**
 * Like readSecret, but returns undefined for bindings that are absent or
 * empty instead of throwing — for secrets that are genuinely optional.
 */
export const readSecretOptional = async (
  value: SecretBindingValue,
  label: string,
): Promise<string | undefined> => {
  if (isString(value)) {
    return value.length > 0 ? value : undefined;
  }
  if (secretBinding(value)) {
    const resolved = await value.get();
    return resolved ? resolved : undefined;
  }
  if (value === undefined) {
    return undefined;
  }
  throw new Error(`Secret binding ${label} has invalid type`);
};
/**
 * Reads a Worker binding that may be a plain string (local dev) or a Secrets
 * Store secret whose value is fetched with `.get()`.
 */
export const readSecret = async (value: SecretBindingValue, label: string): Promise<string> => {
  if (isString(value)) {
    if (value.length > 0) {
      return value;
    }
    throw new Error(`Secret ${label} is empty`);
  }
  if (secretBinding(value)) {
    const resolved = await value.get();
    if (resolved) {
      return resolved;
    }
    throw new Error(`Secret binding ${label} is empty`);
  }
  throw new Error(
    value === undefined
      ? `Secret binding ${label} is not configured`
      : `Secret binding ${label} has invalid type`,
  );
};
