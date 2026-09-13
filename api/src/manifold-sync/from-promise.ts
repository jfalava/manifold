import { errorMessage } from "@manifold/json";
import { Data, Effect } from "effect";

/** A typed failure for Promise APIs that do not expose an Effect error type. */
export class ApiEffectError extends Data.TaggedError("ApiEffectError")<{
  readonly message: string;
}> {}

export const apiError = (message: string): ApiEffectError => new ApiEffectError({ message });

/**
 * Promise boundary: rejections become typed failures (not defects).
 * Prefer this over Effect.promise so Effect.catch can recover.
 */
export const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, ApiEffectError> =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => apiError(errorMessage(cause)),
  });
