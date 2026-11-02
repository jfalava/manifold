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
  // The mount fetch starts immediately, so the first render is already busy.
  const [busy, setBusy] = useState(true);

  const settle = useCallback((outcome: { ok: true; value: T } | { ok: false; cause: unknown }) => {
    if (outcome.ok) {
      setData(outcome.value);
      setError(null);
    } else {
      setError(outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause));
    }

    setBusy(false);
  }, []);

  // Mount fetch: state only changes after the await, and a stale result is dropped on unmount.
  useEffect(() => {
    let cancelled = false;

    void load().then(
      (value) => !cancelled && settle({ ok: true, value }),
      (cause: unknown) => !cancelled && settle({ ok: false, cause }),
    );

    return () => {
      cancelled = true;
    };
  }, [load, settle]);

  const refresh = useCallback(async () => {
    setBusy(true);

    await load().then(
      (value) => settle({ ok: true, value }),
      (cause: unknown) => settle({ ok: false, cause }),
    );
  }, [load, settle]);

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
