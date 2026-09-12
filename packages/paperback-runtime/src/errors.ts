/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { errorMessage, isFiniteNumber, isJsonObject, isString } from "@manifold/json";

export { errorMessage };

/**
 * Paperback's Application.scheduleRequest rejects with host-provided values
 * that are often message-less (going offline surfaces as `{}`). Extract the
 * most specific detail available so transport failures stay diagnosable in
 * device logs instead of rendering as `{}`.
 */
export const bridgeErrorDetail = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (isString(cause) && cause.length > 0) {
    return cause;
  }
  if (isJsonObject(cause)) {
    for (const key of ["message", "error", "description", "localizedDescription", "reason"]) {
      const value = cause[key];
      if (isString(value) && value.length > 0) {
        return value;
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
