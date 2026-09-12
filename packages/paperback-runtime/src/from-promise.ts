import { Effect } from "effect";

/** Promise boundary: rejections become typed failures (not defects). */
export const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: action, catch: (cause) => cause });
