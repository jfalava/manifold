import { Effect } from "effect";
import { decodeJsonOrThrow, fromPromise, parseJsonValue, runHost } from "@/effect-kit";

import { MalSession } from "@/mal";

export const MAL_SECRET = { service: "manifold", name: "mal-session" };

export const saveMalSession = (session: MalSession): Promise<void> =>
  Bun.secrets.set({ ...MAL_SECRET, value: JSON.stringify(session) });

const loadMalSessionEffect = (): Effect.Effect<MalSession | undefined, Error> =>
  Effect.gen(function* () {
    const stored = yield* fromPromise(() => Bun.secrets.get(MAL_SECRET)).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(`MAL keychain read failed: ${String(cause)}`),
      ),
    );
    if (!stored) {
      return undefined;
    }
    try {
      return decodeJsonOrThrow(MalSession, parseJsonValue(stored), "decode");
    } catch {
      return yield* Effect.fail(new Error("Invalid MAL keychain session. Run login mal again."));
    }
  });

export const loadMalSession = (): Promise<MalSession | undefined> =>
  runHost(loadMalSessionEffect());
