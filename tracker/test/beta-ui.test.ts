/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MANIFOLD settings UI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("has no admin or beta sections", async () => {
    vi.stubGlobal("Application", {
      getSecureState: () => undefined,
      getState: () => undefined,
      setSecureState: vi.fn(),
      setState: vi.fn(),
      Selector: (_target: never, key: string) => key,
    });

    const { ManifoldTrackerSource } = await import("../src/MANIFOLD/main");

    const stableForm = await new ManifoldTrackerSource().getSettingsForm();
    const stableSections = stableForm.getSections();
    expect(stableSections.some((section) => section.id === "tracker-ios27-beta-ui")).toBe(false);
    expect(stableSections.some((section) => section.id === "tracker-admin")).toBe(false);
    expect(stableSections.map((section) => section.id)).toEqual([
      "tracker-personal-api",
      "tracker-anilist",
    ]);
  });
});
