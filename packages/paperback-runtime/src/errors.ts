/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { Data } from "effect";
import { errorMessage, isFiniteNumber, isJsonObject, isString } from "@manifold/json";

export class PaperbackRuntimeError extends Data.TaggedError("PaperbackRuntimeError")<{
  readonly message: string;
}> {}

export const paperbackError = (message: string): PaperbackRuntimeError =>
  new PaperbackRuntimeError({ message });

export { errorMessage };

/**
 * Paperback's Application.scheduleRequest rejects with host-provided values
 * that are often message-less (going offline surfaces as `{}`). Extract the
 * most specific detail available so transport failures stay diagnosable in
 * device logs instead of rendering as `{}`.
 */
export const bridgeErrorDetail = (cause: unknown): string => {
  const meaningful = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed !== "{}" ? trimmed : undefined;
  };

  if (cause instanceof Error) {
    const message = meaningful(cause.message);
    if (message !== undefined) {
      return message;
    }
  }
  if (isString(cause)) {
    const message = meaningful(cause);
    if (message !== undefined) {
      return message;
    }
  }
  if (isJsonObject(cause)) {
    for (const key of ["message", "error", "description", "localizedDescription", "reason"]) {
      const value = cause[key];
      if (isString(value)) {
        const message = meaningful(value);
        if (message !== undefined) {
          return message;
        }
      }
    }
    const code = cause["code"];
    if (isFiniteNumber(code) || (isString(code) && code.length > 0)) {
      const domain = cause["domain"];
      return isString(domain) && domain.length > 0
        ? `${domain} (${code})`
        : `request failed (code ${code})`;
    }
  }
  const fallback = errorMessage(cause);
  return fallback === "{}" || fallback.length === 0 ? "network request failed" : fallback;
};
