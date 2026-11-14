import { errorMessage } from "@manifold/json";
import { Data, Effect } from "effect";

export class TrackerEffectError extends Data.TaggedError("TrackerEffectError")<{
  readonly message: string;
}> {}

export const trackerError = (message: string): TrackerEffectError =>
  new TrackerEffectError({ message });

/**
 * AniList answered a progress push and refused it. The read queue counts only
 * these toward dropping a queued retry: an outage or a failed Manifold lookup
 * says nothing about the push.
 */
export class ProgressPushRefused extends Data.TaggedError("ProgressPushRefused")<{
  readonly message: string;
}> {}

/** Promise boundary: rejections become typed failures (not defects). */
export const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, TrackerEffectError> =>
  Effect.tryPromise({ try: action, catch: (cause) => trackerError(errorMessage(cause)) });
