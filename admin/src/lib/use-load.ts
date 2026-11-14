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
 * Latest-wins guard for overlapping loads. Call the guard when a load starts;
 * the function it returns says whether that load is still the newest one, so
 * a slow earlier response cannot overwrite a later one.
 */
export const createLatestGuard = (): (() => () => boolean) => {
  let latest = 0;

  return () => {
    latest += 1;
    const started = latest;

    return () => started === latest;
  };
};

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

  // Every load on this page, mount or refresh, goes through one guard: only the newest settles.
  const [beginLoad] = useState(createLatestGuard);

  // Mount fetch: state only changes after the await, and a stale result is dropped on unmount.
  useEffect(() => {
    let cancelled = false;
    const isLatest = beginLoad();

    void load().then(
      (value) => !cancelled && isLatest() && settle({ ok: true, value }),
      (cause: unknown) => !cancelled && isLatest() && settle({ ok: false, cause }),
    );

    return () => {
      cancelled = true;
    };
  }, [beginLoad, load, settle]);

  const refresh = useCallback(async () => {
    const isLatest = beginLoad();
    setBusy(true);

    // A superseded response is dropped; the newer load settles data, error and busy.
    await load().then(
      (value) => isLatest() && settle({ ok: true, value }),
      (cause: unknown) => isLatest() && settle({ ok: false, cause }),
    );
  }, [beginLoad, load, settle]);

  const act = useCallback<Act>(
    async (action) => {
      setBusy(true);

      try {
        await action();
        // refresh never rejects: it records a failed reload in `error` itself.
        await refresh();
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
