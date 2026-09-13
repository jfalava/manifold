import { errorMessage } from "@manifold/json";
import { Data, Effect } from "effect";

export class TrackerEffectError extends Data.TaggedError("TrackerEffectError")<{
  readonly message: string;
}> {}

export const trackerError = (message: string): TrackerEffectError =>
  new TrackerEffectError({ message });

/** Promise boundary: rejections become typed failures (not defects). */
export const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, TrackerEffectError> =>
  Effect.tryPromise({ try: action, catch: (cause) => trackerError(errorMessage(cause)) });
