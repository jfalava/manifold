import { Effect } from "effect";
import {
  cliError,
  decodeJsonOrThrow,
  fromPromise,
  parseJsonValue,
  runHost,
  type CliEffectError,
} from "@/effect-kit";

import { MalSession } from "@/mal";

export const MAL_SECRET = { service: "manifold", name: "mal-session" };

export const saveMalSession = (session: MalSession): Promise<void> =>
  Bun.secrets.set({ ...MAL_SECRET, value: JSON.stringify(session) });

const loadMalSessionEffect = (): Effect.Effect<MalSession | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const stored = yield* fromPromise(() => Bun.secrets.get(MAL_SECRET)).pipe(
      Effect.mapError((cause) => cliError(`MAL keychain read failed: ${cause.message}`)),
    );
    if (!stored) {
      return undefined;
    }
    return yield* Effect.try({
      try: () => decodeJsonOrThrow(MalSession, parseJsonValue(stored), "decode"),
      catch: () => cliError("Invalid MAL keychain session. Run login mal again."),
    });
  });

export const loadMalSession = (): Promise<MalSession | undefined> =>
  runHost(loadMalSessionEffect());
