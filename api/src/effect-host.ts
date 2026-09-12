import { DateTime, Effect } from "effect";

/** Wall-clock millis for Durable Object / SQL rows (sync host boundary). */
export const epochMillisNow = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

/**
 * UUID for DO row ids. Platform crypto is the CF-native source; Effect Crypto
 * needs a Layer and is not free in sync DO methods.
 */
export const newId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Fire-and-forget host log via Effect Logger (sync flush). */
export const hostLogError = (message: string): void => {
  Effect.runSync(Effect.logError(message));
};

export const hostLogWarn = (message: string): void => {
  Effect.runSync(Effect.logWarning(message));
};

export const hostLogInfo = (message: string): void => {
  Effect.runSync(Effect.logInfo(message));
};

/** Run an Effect at a CF/Hono host boundary. */
export const runHost = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** Fetch that re-reads globalThis.fetch (tests can stub it). */
export const platformFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);
