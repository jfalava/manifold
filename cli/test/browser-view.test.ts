import type { JsonObject } from "@manifold/json";
import { afterEach, expect, it, vi } from "vitest";
import { classifyPage, openBunBrowserView } from "../src/browser-view";

afterEach(() => vi.unstubAllGlobals());

it("classifies challenge titles and HTML without blocking ordinary pages", () => {
  expect(classifyPage("Just a moment...", "")).toBe("challenge");

  for (const marker of ["cf-chl-widget", "challenge-platform", "_cf_chl_token"]) {
    expect(classifyPage("Catalog", marker)).toBe("challenge");
  }

  expect(classifyPage("Catalog", "<main>Books</main>")).toBe("ok");
});

it("opens the requested Chrome backend with the caller's isolated profile", () => {
  const constructed: JsonObject[] = [];

  // Bun.WebView is a constructor, so the stand-in must be constructible.
  class WebView {
    constructor(options: JsonObject) {
      constructed.push(options);
    }
  }

  vi.stubGlobal("Bun", { WebView });
  openBunBrowserView({
    chromeUrl: "ws://127.0.0.1:9222/devtools/browser/1",
    profileDir: "/profile",
  });
  expect(constructed).toEqual([
    {
      width: 1280,
      height: 800,
      backend: { type: "chrome", url: "ws://127.0.0.1:9222/devtools/browser/1" },
      dataStore: { directory: "/profile" },
    },
  ]);
});
