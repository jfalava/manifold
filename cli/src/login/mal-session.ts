/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { Schema } from "effect";

import { MalSession } from "@/mal";

export const MAL_SECRET = { service: "manifold", name: "mal-session" };

export const saveMalSession = (session: MalSession): Promise<void> =>
  Bun.secrets.set({ ...MAL_SECRET, value: JSON.stringify(session) });

export const loadMalSession = async (): Promise<MalSession | undefined> => {
  const stored = await Bun.secrets.get(MAL_SECRET);
  if (!stored) {
    return undefined;
  }
  try {
    return Schema.decodeUnknownSync(MalSession)(JSON.parse(stored));
  } catch {
    throw new Error("Invalid MAL keychain session. Run login mal again.");
  }
};
