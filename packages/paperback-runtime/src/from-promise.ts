import { errorMessage } from "@manifold/json";
import { Effect } from "effect";
import { PaperbackRuntimeError, paperbackError } from "./errors.js";

/** Promise boundary: rejections become typed failures (not defects). */
export const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, PaperbackRuntimeError> =>
  Effect.tryPromise({ try: action, catch: (cause) => paperbackError(errorMessage(cause)) });
