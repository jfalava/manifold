/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MANIFOLD beta UI probes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("publishes the iOS 27 ButtonRow, confirmation, and WebViewRow probes", async () => {
    vi.stubGlobal("Application", {
      getSecureState: () => undefined,
      getState: () => undefined,
      setSecureState: vi.fn(),
      setState: vi.fn(),
      Selector: (_target: never, key: string) => key,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    const [{ ManifoldBetaExtension }, { ManifoldTrackerSource }] = await Promise.all([
      import("../src/MANIFOLD-beta/main"),
      import("../src/MANIFOLD/main"),
    ]);
    const form = await new ManifoldBetaExtension().getSettingsForm();
    const betaSection = form
      .getSections()
      .find((section) => section.id === "tracker-ios27-beta-ui");

    expect(betaSection?.items.map((item) => item.type)).toEqual([
      "labelRow",
      "buttonRow",
      "buttonRow",
      "webViewRow",
    ]);
    expect(betaSection?.items.map((item) => item.id)).toEqual([
      "tracker-ios27-beta-ui-status",
      "tracker-ios27-button-row",
      "tracker-ios27-confirmation",
      "tracker-ios27-web-view-row",
    ]);

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
