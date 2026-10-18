import type { JsonObject, JsonValue } from "@manifold/json";

export interface BrowserView {
  readonly title: string;
  readonly url: string;
  navigate: (url: string) => Promise<void>;
  evaluate: <T = JsonValue>(script: string) => Promise<T>;
  cdp: <T = JsonValue>(method: string, params?: JsonObject) => Promise<T>;
  close: () => void;
}

export const isChallengeText = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return (
    lowered.includes("just a moment") ||
    lowered.includes("cf-chl-") ||
    lowered.includes("challenge-platform") ||
    lowered.includes("_cf_chl_")
  );
};

export const classifyPage = (title: string, html: string): "ok" | "challenge" =>
  isChallengeText(title) || isChallengeText(html) ? "challenge" : "ok";

export const openBunBrowserView = (options: {
  readonly chromeUrl: string;
  readonly profileDir: string;
}): BrowserView =>
  new Bun.WebView({
    width: 1280,
    height: 800,
    backend: { type: "chrome", url: options.chromeUrl },
    dataStore: { directory: options.profileDir },
  });
