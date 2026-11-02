import { isJsonObject, isString } from "@manifold/json";
/** @effect-diagnostics globalFetch:off */
import { Effect, Schema } from "effect";

const WORKERS_MODULE = "cloudflare:workers";

export type AdminWorkersEnv = (typeof import("cloudflare:workers"))["env"];

export interface AdminWorkersRuntime {
  readonly env: AdminWorkersEnv;
  readonly waitUntil: ((promise: Promise<unknown>) => void) | null;
}

export class AdminError extends Schema.TaggedError<AdminError, { readonly brand: unique symbol }>()(
  "AdminError",
  {
    message: Schema.String,
  },
) {}

export const toError = (cause: unknown): AdminError => {
  if (Schema.is(AdminError)(cause)) {
    return cause;
  }

  if (isJsonObject(cause) && isString(cause.message)) {
    return new AdminError({ message: cause.message });
  }

  return new AdminError({ message: String(cause) });
};

/** Convert a host Promise into a typed Effect failure. */
export const tryPromise = <A>(action: () => Promise<A>): Effect.Effect<A, AdminError> =>
  Effect.tryPromise({ try: action, catch: toError });

/** Run an Effect at the TanStack/Cloudflare host boundary. */
export const runHost = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** Fetch that re-reads globalThis.fetch so tests and the Worker host can provide it. */
export const platformFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

interface WorkersModule {
  readonly env: AdminWorkersEnv;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** workerd owns this module's shape; check only what the admin reads. */
const isWorkersModule = (value: unknown): value is WorkersModule =>
  typeof value === "object" &&
  value !== null &&
  "env" in value &&
  typeof value.env === "object" &&
  (!("waitUntil" in value) || typeof value.waitUntil === "function");

/** Read a secret binding that Alchemy may expose as a plain string or a handle. */
export const resolveSecret = Effect.fnUntraced(function* (
  binding: string | AlchemySecret,
): Effect.fn.Return<string | null, AdminError> {
  if (isString(binding)) {
    return binding;
  }

  // Secrets Store bindings are Workers RPC stubs: every property read becomes a
  // remote method, so call `get` on the binding itself (never `.call`/`.bind`).
  if (binding.get) {
    const secret = binding;
    const value = yield* tryPromise(() => secret.get?.() ?? Promise.resolve(undefined));

    return isString(value) ? value : null;
  }

  return isString(binding.value) ? binding.value : null;
});

/** Load Cloudflare's Worker host module without making it a build-time dependency. */
export const workersRuntime = Effect.fnUntraced(function* () {
  const mod: unknown = yield* tryPromise(() => import(/* @vite-ignore */ WORKERS_MODULE));

  if (!isWorkersModule(mod)) {
    return yield* new AdminError({ message: "cloudflare:workers module unavailable" });
  }

  return {
    env: mod.env,
    waitUntil: mod.waitUntil ?? null,
  } satisfies AdminWorkersRuntime;
});
