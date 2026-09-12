import { DateTime, Effect } from "effect";

/** Wall-clock millis for Durable Object / SQL rows (sync host boundary). */
export const epochMillisNow = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

/**
 * UUID for DO row ids. Platform crypto is the CF-native source; Effect Crypto
 * needs a Layer and is not free in sync DO methods.
 */
// @effect-diagnostics-next-line cryptoRandomUUID:off
export const newId = (): string => crypto.randomUUID();

/** Fire-and-forget host log (CF worker / DO console is the log sink). */
export const hostLogError = (message: string): void => {
  // @effect-diagnostics-next-line globalConsole:off
  console.error(message);
};

export const hostLogWarn = (message: string): void => {
  // @effect-diagnostics-next-line globalConsole:off
  console.warn(message);
};

export const hostLogInfo = (message: string): void => {
  // @effect-diagnostics-next-line globalConsole:off
  console.info(message);
};

/** Run an Effect at a CF/Hono host boundary. */
export const runHost = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);
