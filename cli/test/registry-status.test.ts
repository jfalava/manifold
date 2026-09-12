/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { describe, expect, it } from "vitest";
import { matchesStatusFilter, parseStatusFilter } from "../src/registry-status";

describe("registry prefill --status", () => {
  it("treats auto as no filter", () => {
    expect(parseStatusFilter("auto")).toBeUndefined();
    expect(parseStatusFilter("")).toBeUndefined();
    expect(matchesStatusFilter(undefined, undefined)).toBe(true);
    expect(matchesStatusFilter("dropped", undefined)).toBe(true);
  });

  it("expands PAS5-style reading to reading + re_reading", () => {
    const filter = parseStatusFilter("reading");
    expect(filter).toEqual(new Set(["reading", "re_reading"]));
    expect(matchesStatusFilter("reading", filter)).toBe(true);
    expect(matchesStatusFilter("re_reading", filter)).toBe(true);
    expect(matchesStatusFilter("plan_to_read", filter)).toBe(false);
    expect(matchesStatusFilter(undefined, filter)).toBe(false);
  });

  it("accepts registry and PAS5 names in a comma list", () => {
    const filter = parseStatusFilter("paused,planning,completed");
    expect(filter).toEqual(new Set(["on_hold", "plan_to_read", "completed"]));
  });

  it("rejects unknown statuses", () => {
    expect(() => parseStatusFilter("wishlist")).toThrow(/unknown status "wishlist"/);
  });
});
