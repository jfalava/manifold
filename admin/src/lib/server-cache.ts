/**
 * Stale-while-revalidate JSON cache for server-fn snapshots.
 *
 * Layers: a per-isolate L1 map (fast path, dies with the isolate) over the
 * ADMIN_CACHE KV namespace (survives isolate eviction, so a cold isolate
 * still answers instantly from the last stored snapshot). Fresh data is
 * served as-is; stale-but-present data is served immediately while a
 * deduplicated background refresh (ctx.waitUntil) recomputes it; only a
 * fully cold key pays the compute cost inline.
 *
 * Cache failures must never break a dashboard — every KV interaction
 * degrades to plain compute.
 */

import { DateTime, Deferred, Effect, Option, Schema } from "effect";

import { AdminError, runHost, toError, tryPromise, workersRuntime } from "./effect-host";
import { isJsonObject, isNumberValue } from "./guards";

/** How long a stored snapshot is served without triggering a refresh. */
const SOFT_TTL_MS = 60_000;
/** Hard KV expiry — the longest a stale snapshot can ever be served. */
const KV_TTL_SECONDS = 21_600; // 6h
const JsonString = Schema.fromJsonString(Schema.Unknown);

interface Envelope<T> {
  readonly storedAt: number;
  readonly value: T;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: every cache decoder validates persisted JSON before returning its domain type
export type CacheDecoder<T> = (value: unknown) => T | undefined;

interface WorkersRuntime {
  readonly kv: KVNamespace | null;
  readonly waitUntil: ((promise: Promise<unknown>) => void) | null;
}

const l1 = new Map<string, Envelope<unknown>>();
const inflight = new Map<string, Deferred.Deferred<unknown, AdminError>>();
const invalidationEpoch = new Map<string, number>();

const workersCacheRuntime = workersRuntime().pipe(
  Effect.map(
    ({ env, waitUntil }) =>
      ({
        kv: env.ADMIN_CACHE ?? null,
        waitUntil,
      }) satisfies WorkersRuntime,
  ),
  Effect.orElseSucceed(() => ({ kv: null, waitUntil: null }) satisfies WorkersRuntime),
);

const readKv = Effect.fnUntraced(function* <T>(
  kv: KVNamespace,
  key: string,
  decode: CacheDecoder<T>,
) {
  const text = yield* tryPromise(() => kv.get(key, "text")).pipe(Effect.orElseSucceed(() => null));
  if (text === null) {
    return null;
  }
  const decoded = Schema.decodeOption(JsonString)(text);
  const parsed = Option.isSome(decoded) ? decoded.value : null;
  if (!isJsonObject(parsed) || !isNumberValue(parsed.storedAt) || !("value" in parsed)) {
    return null;
  }
  const value = decode(parsed.value);
  return value === undefined ? null : ({ storedAt: parsed.storedAt, value } satisfies Envelope<T>);
});

const writeKv = Effect.fnUntraced(function* (
  kv: KVNamespace,
  key: string,
  envelope: Envelope<unknown>,
) {
  yield* Schema.encodeEffect(JsonString)(envelope).pipe(
    Effect.mapError(toError),
    Effect.flatMap((encoded) =>
      tryPromise(() => kv.put(key, encoded, { expirationTtl: KV_TTL_SECONDS })),
    ),
    Effect.ignore,
  );
});

export interface ComputedSnapshot<T> {
  readonly value: T;
  /** Only healthy results are stored; errors are returned but never cached. */
  readonly cacheable: boolean;
}

const computeAndStore = Effect.fnUntraced(function* <T>(
  key: string,
  kv: KVNamespace | null,
  decode: CacheDecoder<T>,
  compute: () => Effect.Effect<ComputedSnapshot<T>, AdminError>,
) {
  const acquired = yield* Effect.sync(() => {
    const existing = inflight.get(key);
    if (existing !== undefined) {
      return { deferred: existing, owner: false } as const;
    }
    const deferred = Deferred.makeUnsafe<unknown, AdminError>();
    inflight.set(key, deferred);
    return {
      deferred,
      epoch: invalidationEpoch.get(key) ?? 0,
      owner: true,
    } as const;
  });

  if (!acquired.owner) {
    const value = yield* Deferred.await(acquired.deferred);
    const decoded = decode(value);
    if (decoded === undefined) {
      return yield* new AdminError({
        message: `Cache computation for ${key} returned an invalid value`,
      });
    }
    return decoded;
  }

  return yield* compute().pipe(
    Effect.tap(({ value, cacheable }) =>
      cacheable
        ? Effect.gen(function* () {
            if ((invalidationEpoch.get(key) ?? 0) === acquired.epoch) {
              const envelope: Envelope<T> = {
                storedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
                value,
              };
              l1.set(key, envelope);
              if (kv !== null) {
                yield* writeKv(kv, key, envelope);
              }
            }
            yield* Deferred.succeed(acquired.deferred, value);
          })
        : Deferred.succeed(acquired.deferred, value),
    ),
    Effect.tapError((error) => Deferred.fail(acquired.deferred, error)),
    Effect.ensuring(
      Effect.sync(() => {
        if (inflight.get(key) === acquired.deferred) {
          inflight.delete(key);
        }
      }),
    ),
    Effect.map(({ value }) => value),
  );
});

const cachedJsonEffect = Effect.fnUntraced(function* <T>(
  key: string,
  decode: CacheDecoder<T>,
  compute: () => Effect.Effect<ComputedSnapshot<T>, AdminError>,
) {
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());

  const local = l1.get(key);
  if (local !== undefined && now - local.storedAt < SOFT_TTL_MS) {
    const value = decode(local.value);
    if (value !== undefined) {
      return value;
    }
    l1.delete(key);
  }

  const { kv, waitUntil } = yield* workersCacheRuntime;
  const stored = kv === null ? null : yield* readKv(kv, key, decode);
  if (stored !== null) {
    l1.set(key, stored);
    if (now - stored.storedAt < SOFT_TTL_MS) {
      return stored.value;
    }
    // Stale: serve it now, refresh out of band. Without waitUntil the
    // refresh promise may be cancelled after the response — acceptable,
    // the next request retries.
    const refresh = runHost(computeAndStore(key, kv, decode, compute)).catch(() => undefined);
    if (waitUntil !== null) {
      waitUntil(refresh);
    }
    return stored.value;
  }

  // Serve a stale L1 value the same way when KV is unavailable.
  if (local !== undefined) {
    const value = decode(local.value);
    if (value === undefined) {
      l1.delete(key);
      return yield* computeAndStore(key, kv, decode, compute);
    }
    const refresh = runHost(computeAndStore(key, kv, decode, compute)).catch(() => undefined);
    if (waitUntil !== null) {
      waitUntil(refresh);
    }
    return value;
  }

  return yield* computeAndStore(key, kv, decode, compute);
});

/** Effect-native cache operation for server-side composition. */
export const cachedJsonProgram = cachedJsonEffect;

/** Promise adapter for non-Effect callers. */
export function cachedJson<T>(
  key: string,
  decode: CacheDecoder<T>,
  compute: () => Effect.Effect<ComputedSnapshot<T>, AdminError>,
): Promise<T> {
  return runHost(cachedJsonEffect(key, decode, compute));
}

const invalidateCachedJsonEffect = Effect.fnUntraced(function* (key: string) {
  yield* Effect.sync(() => {
    l1.delete(key);
    invalidationEpoch.set(key, (invalidationEpoch.get(key) ?? 0) + 1);
    inflight.delete(key);
  });
  const { kv } = yield* workersCacheRuntime;
  if (kv === null) {
    return;
  }
  yield* tryPromise(() => kv.delete(key)).pipe(Effect.ignore);
});

/** Effect-native invalidation for server-side composition. */
export const invalidateCachedJsonProgram = invalidateCachedJsonEffect;

/** Promise adapter for non-Effect callers. */
export function invalidateCachedJson(key: string): Promise<void> {
  return runHost(invalidateCachedJsonEffect(key));
}
