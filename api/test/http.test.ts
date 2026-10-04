/** @effect-diagnostics asyncFunction:off */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { boundedInteger, routeId } from "../src/http";

describe("HTTP route parsing", () => {
  it("rejects malformed percent-encoded route IDs", async () => {
    await expect(Effect.runPromise(routeId("bad%2"))).rejects.toMatchObject({
      _tag: "ParseRequestError",
      message: "Route identifier is not valid URL encoding",
    });
  });

  it("normalizes invalid and out-of-range query integers", () => {
    expect(boundedInteger(null, 20, 1, 100)).toBe(20);
    expect(boundedInteger("1garbage", 20, 1, 100)).toBe(20);
    expect(boundedInteger("1.5", 20, 1, 100)).toBe(20);
    expect(boundedInteger("-5", 20, 1, 100)).toBe(1);
    expect(boundedInteger("500", 20, 1, 100)).toBe(100);
  });
});
