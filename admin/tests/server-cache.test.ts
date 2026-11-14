import { expect, test } from "bun:test";

import { isString } from "@manifold/json";
import { Effect } from "effect";

import { cachedJson, type CacheDecoder, type ComputedSnapshot } from "../src/lib/server-cache";

const decodeString: CacheDecoder<string> = (value) => (isString(value) ? value : undefined);

test("a caller waiting on an in-flight computation is released when that computation dies", async () => {
  const gate = Promise.withResolvers<void>();
  let computations = 0;

  const compute = (): Effect.Effect<ComputedSnapshot<string>> => {
    computations += 1;

    return Effect.promise(() => gate.promise).pipe(
      Effect.andThen(Effect.die(new Error("loader defect"))),
    );
  };

  const owner = cachedJson("test:defect", decodeString, compute);
  const waiter = cachedJson("test:defect", decodeString, compute);

  const ownerOutcome = owner.then(
    () => "resolved",
    () => "rejected",
  );

  // Race against a timer: a waiter that never settles would hang the test runner.
  const waiterOutcome = Promise.race([
    waiter.then(
      () => "resolved",
      (cause: Error) => `rejected: ${cause.message}`,
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve("still waiting");
      }, 500);
    }),
  ]);

  // Both callers are past the cache lookup once the owner's loader has started.
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  expect(computations).toBe(1);

  gate.resolve();

  await expect(ownerOutcome).resolves.toBe("rejected");

  await expect(waiterOutcome).resolves.toBe(
    "rejected: Cache computation for test:defect did not complete",
  );

  // The dead computation left nothing behind: the next caller computes afresh.
  await expect(
    cachedJson("test:defect", decodeString, () =>
      Effect.succeed({ value: "fresh", cacheable: false }),
    ),
  ).resolves.toBe("fresh");
}, 2000);
