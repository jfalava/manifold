/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { DateTime, Effect } from "effect";

/** Wall-clock millis for Durable Object / SQL rows (sync host boundary). */
export const epochMillisNow = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

/**
 * UUID for DO row ids. Platform crypto is the CF-native source; Effect Crypto
 * needs a Layer and is not free in sync DO methods.
 */
export const newId = (): string => crypto.randomUUID();

/** Fire-and-forget host log (CF worker / DO console is the log sink). */
export const hostLogError = (message: string): void => {
  console.error(message);
};

export const hostLogWarn = (message: string): void => {
  console.warn(message);
};

export const hostLogInfo = (message: string): void => {
  console.info(message);
};

/** Run an Effect at a CF/Hono host boundary. */
export const runHost = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);
