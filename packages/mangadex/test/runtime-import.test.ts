/** @effect-diagnostics asyncFunction:off */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Paperback runtime compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads without a global fetch implementation", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", undefined);

    const module = await import("../src/index.js");

    expect(module.createMangaDexClient).toBeTypeOf("function");
  });
});
