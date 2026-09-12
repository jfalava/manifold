import { isString } from "@manifold/json";
import type { SecretsStoreSecret } from "@cloudflare/workers-types";
import { Data, Effect } from "effect";

type SecretBindingValue = string | SecretsStoreSecret | undefined;

export class SecretBindingError extends Data.TaggedError("SecretBindingError")<{
  readonly label: string;
  readonly message: string;
}> {}

const secretBinding = (value: SecretBindingValue): value is SecretsStoreSecret =>
  typeof value === "object" && value !== null && typeof value.get === "function";

const fail = (label: string, message: string) =>
  Effect.fail(new SecretBindingError({ label, message }));

const readSecretOptionalEffect = (
  value: SecretBindingValue,
  label: string,
): Effect.Effect<string | undefined, SecretBindingError> =>
  Effect.gen(function* () {
    if (isString(value)) {
      return value.length > 0 ? value : undefined;
    }
    if (secretBinding(value)) {
      const resolved = yield* Effect.tryPromise({
        try: () => value.get(),
        catch: () => new SecretBindingError({ label, message: `Secret binding ${label} failed` }),
      });
      return resolved ? resolved : undefined;
    }
    if (value === undefined) {
      return undefined;
    }
    return yield* fail(label, `Secret binding ${label} has invalid type`);
  });

const readSecretEffect = (
  value: SecretBindingValue,
  label: string,
): Effect.Effect<string, SecretBindingError> =>
  Effect.gen(function* () {
    if (isString(value)) {
      if (value.length > 0) {
        return value;
      }
      return yield* fail(label, `Secret ${label} is empty`);
    }
    if (secretBinding(value)) {
      const resolved = yield* Effect.tryPromise({
        try: () => value.get(),
        catch: () => new SecretBindingError({ label, message: `Secret binding ${label} failed` }),
      });
      if (resolved) {
        return resolved;
      }
      return yield* fail(label, `Secret binding ${label} is empty`);
    }
    return yield* fail(
      label,
      value === undefined
        ? `Secret binding ${label} is not configured`
        : `Secret binding ${label} has invalid type`,
    );
  });

/**
 * Like readSecret, but returns undefined for bindings that are absent or
 * empty instead of throwing — for secrets that are genuinely optional.
 */
export const readSecretOptional = (
  value: SecretBindingValue,
  label: string,
): Promise<string | undefined> => Effect.runPromise(readSecretOptionalEffect(value, label));

/**
 * Reads a Worker binding that may be a plain string (local dev) or a Secrets
 * Store secret whose value is fetched with `.get()`.
 */
export const readSecret = (value: SecretBindingValue, label: string): Promise<string> =>
  Effect.runPromise(readSecretEffect(value, label));
