import { expect, test } from "bun:test";

import { Effect } from "effect";

import { DO_INVOCATIONS_QUERY, runGraphQL, WORKER_INVOCATIONS_QUERY } from "../src/lib/analytics";

const MANIFOLD_SCRIPTS = ["manifold-router", "manifold-api", "manifold-docs", "manifold-admin"];

test("the Worker invocations query asks only for the Manifold scripts and for every hourly row", () => {
  // Without the filter the account's other Workers fill the row limit and the
  // Manifold totals come out short.
  expect(WORKER_INVOCATIONS_QUERY).toContain(
    `scriptName_in: [${MANIFOLD_SCRIPTS.map((name) => `"${name}"`).join(", ")}]`,
  );

  const limit = Number(/limit: (\d+)/.exec(WORKER_INVOCATIONS_QUERY)?.[1]);

  // One row per script per hour; a 24-hour window touches 25 hourly buckets.
  expect(limit).toBeGreaterThan(MANIFOLD_SCRIPTS.length * 25);
});

test("the Durable Object invocations query counts only the Manifold API's objects", () => {
  expect(DO_INVOCATIONS_QUERY).toContain(`scriptName: "manifold-api"`);
});

test("a Cloudflare GraphQL request carries an abort signal", async () => {
  const realFetch = globalThis.fetch;
  const signals: (AbortSignal | null | undefined)[] = [];

  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);

      return Response.json({ data: {}, errors: null });
    },
    { preconnect: realFetch.preconnect },
  );

  try {
    expect(await Effect.runPromise(runGraphQL("token", "query { viewer }", {}, () => "ok"))).toBe(
      "ok",
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(signals).toHaveLength(1);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[0]?.aborted).toBe(false);
});
