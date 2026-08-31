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

import { isFunctionValue, isJsonObject, isNumberValue } from "./guards";
import { trusted } from "./trusted-cast";

/** How long a stored snapshot is served without triggering a refresh. */
const SOFT_TTL_MS = 60_000;
/** Hard KV expiry — the longest a stale snapshot can ever be served. */
const KV_TTL_SECONDS = 21_600; // 6h

interface Envelope<T> {
  readonly storedAt: number;
  readonly value: T;
}

// Indirect the specifier so bundlers (rolldown) don't try to resolve
// "cloudflare:workers" at build time — workerd provides it at runtime.
const WORKERS_MODULE = "cloudflare:workers";

interface WorkersRuntime {
  readonly kv: KVNamespace | null;
  readonly waitUntil: ((promise: Promise<unknown>) => void) | null;
}

async function workersRuntime(): Promise<WorkersRuntime> {
  try {
    const mod: unknown = await import(/* @vite-ignore */ WORKERS_MODULE);
    if (!isJsonObject(mod) || !("env" in mod)) {
      return { kv: null, waitUntil: null };
    }
    // SAFETY: workerd owns the cloudflare:workers module shape; presence of env is validated above and waitUntil is guarded below
    const runtime = trusted<{
      readonly env: { readonly ADMIN_CACHE?: KVNamespace };
      readonly waitUntil?: (promise: Promise<unknown>) => void;
    }>(mod);
    return {
      kv: runtime.env.ADMIN_CACHE ?? null,
      waitUntil: isFunctionValue(runtime.waitUntil) ? runtime.waitUntil : null,
    };
  } catch {
    // Not running on workerd (vite dev) — L1-only caching.
    return { kv: null, waitUntil: null };
  }
}

const l1 = new Map<string, Envelope<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

async function readKv<T>(kv: KVNamespace, key: string): Promise<Envelope<T> | null> {
  try {
    const text = await kv.get(key, "text");
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed) || !isNumberValue(parsed.storedAt) || !("value" in parsed)) {
      return null;
    }
    return { storedAt: parsed.storedAt, value: trusted<T>(parsed.value) };
  } catch {
    return null;
  }
}

async function writeKv(kv: KVNamespace, key: string, envelope: Envelope<unknown>): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(envelope), { expirationTtl: KV_TTL_SECONDS });
  } catch {
    // Best effort — the value was still computed and returned.
  }
}

export interface ComputedSnapshot<T> {
  readonly value: T;
  /** Only healthy results are stored; errors are returned but never cached. */
  readonly cacheable: boolean;
}

const computeAndStore = async <T>(
  key: string,
  kv: KVNamespace | null,
  compute: () => Promise<ComputedSnapshot<T>>,
): Promise<T> => {
  const running = inflight.get(key);
  if (running !== undefined) {
    return trusted<T>(await running);
  }
  const task = (async () => {
    const { value, cacheable } = await compute();
    if (cacheable) {
      const envelope: Envelope<T> = { storedAt: Date.now(), value };
      l1.set(key, envelope);
      if (kv !== null) {
        await writeKv(kv, key, envelope);
      }
    }
    return value;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
};

/**
 * Serve `key` from cache when possible, computing (and storing) otherwise.
 * Stale hits return immediately and refresh in the background.
 */
export async function cachedJson<T>(
  key: string,
  compute: () => Promise<ComputedSnapshot<T>>,
): Promise<T> {
  const now = Date.now();

  const local = l1.get(key);
  if (local !== undefined && now - local.storedAt < SOFT_TTL_MS) {
    return trusted<T>(local.value);
  }

  const { kv, waitUntil } = await workersRuntime();

  const stored = kv === null ? null : await readKv<T>(kv, key);
  if (stored !== null) {
    l1.set(key, stored);
    if (now - stored.storedAt < SOFT_TTL_MS) {
      return stored.value;
    }
    // Stale: serve it now, refresh out of band. Without waitUntil the
    // refresh promise may be cancelled after the response — acceptable,
    // the next request retries.
    const refresh = computeAndStore(key, kv, compute).catch(() => undefined);
    if (waitUntil !== null) {
      waitUntil(refresh);
    }
    return stored.value;
  }

  // Serve a stale L1 value the same way when KV is unavailable.
  if (local !== undefined) {
    const refresh = computeAndStore(key, kv, compute).catch(() => undefined);
    if (waitUntil !== null) {
      waitUntil(refresh);
    }
    return trusted<T>(local.value);
  }

  return computeAndStore(key, kv, compute);
}
