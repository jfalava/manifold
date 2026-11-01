/** @effect-diagnostics asyncFunction:off */
import { useCallback, useEffect, useState } from "react";

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

export type Act = (action: () => Promise<void>) => Promise<void>;

/**
 * Page data that loads on mount and reloads after each mutation. `act` runs a
 * mutation, then refreshes; a failure from either lands in `error`.
 */
export function useRefreshingLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);

    try {
      setData(await load());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount syncs with the API; busy must flip before the await
    void refresh();
  }, [refresh]);

  const act = useCallback<Act>(
    async (action) => {
      setBusy(true);

      try {
        await action();
        await refresh();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { data, error, busy, refresh, act };
}
