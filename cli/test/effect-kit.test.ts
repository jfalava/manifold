import { describe, expect, it } from "vitest";

import { validateNonNegativeLimit } from "../src/effect-kit";

describe("CLI bounded integer flags", () => {
  it("accepts omitted, zero, and positive safe limits", () => {
    expect(() => validateNonNegativeLimit(undefined)).not.toThrow();
    expect(() => validateNonNegativeLimit(0)).not.toThrow();
    expect(() => validateNonNegativeLimit(25)).not.toThrow();
  });

  it("rejects negative, fractional, and unsafe limits instead of treating them as all", () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateNonNegativeLimit(value)).toThrow(
        "--limit must be a non-negative integer",
      );
    }
  });
});
