/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
/**
 * The one sanctioned `unknown -> T` escape hatch, for values whose shape is
 * guaranteed by a contract we own: responses from our router and GraphQL
 * queries we authored. Everything else must narrow at runtime with guards.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters, anti-slop/no-unknown-parameters -- SAFETY: single sanctioned boundary parser; callers own the schema and validate before casting
export function trusted<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: value shape is guaranteed by owned router contract or validated at call site; this is the lone escape hatch per file header
  return value as T;
}
