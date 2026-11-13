/** @effect-diagnostics asyncFunction:off */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { boundedInteger, ParseRequestError, routeId } from "../src/http";
import { handleOps } from "../src/routes/ops";
import { testEnv, unusedSyncStub } from "./env-fixture";

describe("HTTP route parsing", () => {
  it("rejects malformed percent-encoded route IDs", async () => {
    const error: unknown = await Effect.runPromise(routeId("bad%2")).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ParseRequestError);
    expect(error).toMatchObject({ message: "Route identifier is not valid URL encoding" });
  });

  it("normalizes invalid and out-of-range query integers", () => {
    expect(boundedInteger(null, 20, 1, 100)).toBe(20);
    expect(boundedInteger("1garbage", 20, 1, 100)).toBe(20);
    expect(boundedInteger("1.5", 20, 1, 100)).toBe(20);
    expect(boundedInteger("-5", 20, 1, 100)).toBe(1);
    expect(boundedInteger("500", 20, 1, 100)).toBe(100);
  });

  it("caps the pending AniList page at the 100 ops the outbox hands out", async () => {
    const limits: (number | undefined)[] = [];
    const url = new URL("https://api.manifold.test/v1/ops/pending/anilist?limit=500");

    const response = await Effect.runPromise(
      handleOps({
        request: new Request(url),
        env: {
          ...testEnv(),
          MANIFOLD_SYNC: {
            getByName: () => ({
              ...unusedSyncStub(),
              pendingAniListOps: async (limit) => {
                limits.push(limit);

                return [];
              },
            }),
          },
        },
        url,
        path: ["v1", "ops", "pending", "anilist"],
      }),
    );

    expect(response?.status).toBe(200);
    expect(limits).toEqual([100]);
  });
});
