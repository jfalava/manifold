import { describe, expect, it } from "vitest";

import { recheckStalePlan } from "../src/commands/mangadex/stale-status";

const DAY_MS = 86_400_000;
const savedAt = "2026-11-01T00:00:00.000Z";
const savedMs = Date.parse(savedAt);

describe("stale-status --use-plan recheck", () => {
  it("drops plan entries whose status changed or that left the shelf", () => {
    const recheck = recheckStalePlan(
      { savedAt, staleIds: ["still-reading", "finished-since", "removed-since", "re-reading"] },
      { "still-reading": "reading", "finished-since": "completed", "re-reading": "re_reading" },
      ["reading", "re_reading"],
      savedMs + DAY_MS,
    );

    expect(recheck).toEqual({ expired: false, staleIds: ["still-reading", "re-reading"] });
  });

  it("refuses a plan that is 7 days old, from the future, or undated", () => {
    const plan = (at: string) => ({ savedAt: at, staleIds: [] });

    expect(recheckStalePlan(plan(savedAt), {}, [], savedMs + 7 * DAY_MS - 1).expired).toBe(false);
    expect(recheckStalePlan(plan(savedAt), {}, [], savedMs + 7 * DAY_MS).expired).toBe(true);
    expect(recheckStalePlan(plan(savedAt), {}, [], savedMs - 1).expired).toBe(true);
    expect(recheckStalePlan(plan("not a date"), {}, [], savedMs).expired).toBe(true);
  });
});
