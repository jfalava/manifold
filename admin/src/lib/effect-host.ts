/** @effect-diagnostics globalFetch:off */
import { Effect, Schema } from "effect";

import { isFunctionValue, isJsonObject, isStringValue } from "./guards";
import { trusted } from "./trusted-cast";

const WORKERS_MODULE = "cloudflare:workers";

export type AdminWorkersEnv = (typeof import("cloudflare:workers"))["env"];

export interface AdminWorkersRuntime {
  readonly env: AdminWorkersEnv;
  readonly waitUntil: ((promise: Promise<unknown>) => void) | null;
}

export class AdminError extends Schema.TaggedError<AdminError>()("AdminError", {
  message: Schema.String,
}) {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: host-boundary failures are normalized before entering the Effect error channel
export const toError = (cause: unknown): AdminError => {
  if (Schema.is(AdminError)(cause)) {
    return cause;
  }
  if (isJsonObject(cause) && isStringValue(cause.message)) {
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

/** Load Cloudflare's Worker host module without making it a build-time dependency. */
export const workersRuntime = Effect.fnUntraced(function* () {
  const mod: unknown = yield* tryPromise(() => import(/* @vite-ignore */ WORKERS_MODULE));
  if (!isJsonObject(mod) || !("env" in mod)) {
    return yield* new AdminError({ message: "cloudflare:workers module unavailable" });
  }
  // SAFETY: workerd owns the cloudflare:workers module shape; env is validated above and waitUntil is guarded below
  const runtime = trusted<{
    readonly env: AdminWorkersEnv;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  }>(mod);
  return {
    env: runtime.env,
    waitUntil: isFunctionValue(runtime.waitUntil) ? runtime.waitUntil : null,
  } satisfies AdminWorkersRuntime;
});
