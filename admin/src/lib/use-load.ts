/** Admin server/route host (TanStack Start + React). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { useEffect, useState } from "react";

export type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/**
 * One-shot SPA fetch for dashboard widgets. Shell paints immediately; each
 * caller owns its own skeleton so slow widgets don't block fast ones.
 */
export function useLoad<T>(load: () => Promise<T>): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect -- SPA widget boot: fetch once on mount
    void (async () => {
      try {
        const value = await load();
        if (!cancelled) {
          setState({ status: "ready", value });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            status: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  return state;
}
