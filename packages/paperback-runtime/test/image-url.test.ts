/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics schemaSync:off */
import { describe, expect, it } from "vitest";

import { PAPERBACK_FALLBACK_IMAGE_URL, safeImageUrl } from "../src/image-url";

describe("safeImageUrl", () => {
  it("keeps valid HTTP image URLs", () => {
    expect(safeImageUrl(" https://example.test/cover.jpg ")).toBe("https://example.test/cover.jpg");
  });

  it("replaces missing and malformed URLs with a valid image URL", () => {
    for (const value of [undefined, "", "  ", "cover.jpg", "//cdn.example/cover.jpg"]) {
      expect(safeImageUrl(value)).toBe(PAPERBACK_FALLBACK_IMAGE_URL);
    }
  });
});
