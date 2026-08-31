import { describe, expect, it } from "vitest";
import {
  chromeLaunchArgs,
  classifyPage,
  COMIX_CAPTURE_BOOTSTRAP,
  comixProfileDir,
  createComixBrowser,
  findChromeDevToolsUrl,
  parseChromeVersionEndpoint,
  parseDevToolsActivePort,
  waitForChromeDevToolsUrl,
  type ComixView,
} from "../src/comix-capture";
import type { ComixCookie } from "../src/comix-session";

class FakeView implements ComixView {
  title = "";
  url = "";
  navigations: string[] = [];
  cdpCalls: { method: string; params?: Record<string, unknown> }[] = [];
  cookies: ComixCookie[] = [];
  closed = false;
  pages = new Map<string, { title: string; html: string; payload: unknown }>();

  async navigate(next: string): Promise<void> {
    this.navigations.push(next);
    this.url = next;
    this.title = this.pages.get(next)?.title ?? "";
  }

  async evaluate<T = unknown>(script: string): Promise<T> {
    const page = this.pages.get(this.url);
    if (script.includes("document.title")) {
      return {
        title: page?.title ?? this.title,
        html: page?.html ?? "",
        ua: "Mozilla/5.0 Chrome/126",
      } as T;
    }
    if (script.includes("navigator.userAgent")) {
      return "Mozilla/5.0 Chrome/126" as T;
    }
    if (script.includes("__comixResult__")) {
      return page?.payload as T;
    }
    throw new Error(`unexpected evaluate: ${script}`);
  }

  async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.cdpCalls.push({ method, params });
    if (method === "Network.setCookies") {
      const cookies = Array.isArray(params?.cookies) ? params.cookies : [];
      this.cookies = cookies as ComixCookie[];
      return {} as T;
    }
    if (method === "Network.getCookies") {
      return { cookies: this.cookies } as T;
    }
    return {} as T;
  }

  close(): void {
    this.closed = true;
  }
}

describe("comix webview capture", () => {
  it("keeps the Chrome profile under ~/.manifold", () => {
    expect(comixProfileDir("/Users/ada")).toBe("/Users/ada/.manifold/comix-chrome");
  });

  it("parses Chrome's DevToolsActivePort file into a websocket URL", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc")).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
    expect(parseDevToolsActivePort("not-a-port\n/devtools/browser/abc")).toBeUndefined();
  });

  it("picks the first readable DevToolsActivePort candidate", () => {
    expect(
      findChromeDevToolsUrl(
        ["/missing", "/chrome/DevToolsActivePort"],
        (file) => file.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/live" : undefined,
      ),
    ).toBe("ws://127.0.0.1:9222/devtools/browser/live");
  });

  it("reads the websocket URL from /json/version", () => {
    expect(
      parseChromeVersionEndpoint(
        JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }),
      ),
    ).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(parseChromeVersionEndpoint("{}")).toBeUndefined();
  });

  it("launches Chrome with a dedicated profile so --remote-debugging-port is honored", () => {
    expect(chromeLaunchArgs("/Users/ada/.manifold/comix-chrome")).toEqual([
      "--remote-debugging-port=9222",
      "--user-data-dir=/Users/ada/.manifold/comix-chrome",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "https://comix.to/",
    ]);
  });

  it("polls until DevTools is live, then gives up", async () => {
    let attempts = 0;
    const url = await waitForChromeDevToolsUrl({
      timeoutMs: 1_000,
      intervalMs: 1,
      now: () => attempts * 10,
      sleep: async () => {
        attempts += 1;
      },
      probe: async () => (attempts >= 2 ? "ws://127.0.0.1:9222/devtools/browser/ok" : undefined),
    });
    expect(url).toBe("ws://127.0.0.1:9222/devtools/browser/ok");

    const missing = await waitForChromeDevToolsUrl({
      timeoutMs: 20,
      intervalMs: 1,
      now: (() => {
        let t = 0;
        return () => {
          const current = t;
          t += 10;
          return current;
        };
      })(),
      sleep: async () => undefined,
      probe: async () => undefined,
    });
    expect(missing).toBeUndefined();
  });

  it("classifies Cloudflare interstitials before waiting on JSON.parse", () => {
    expect(classifyPage("Just a moment...", "<html></html>")).toBe("challenge");
    expect(classifyPage("Browse", "<div class=\"cf-chl-widget\"></div>")).toBe("challenge");
    expect(classifyPage("Browse", "<main>results</main>")).toBe("ok");
  });

  it("installs the JSON.parse hook once and seeds cookies over CDP", async () => {
    const view = new FakeView();
    await createComixBrowser({
      view,
      cookies: [{ name: "cf_clearance", value: "tok", domain: "comix.to" }],
    });
    expect(view.navigations[0]).toBe("about:blank");
    expect(view.cdpCalls.map((call) => call.method)).toEqual([
      "Page.enable",
      "Network.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Network.setCookies",
    ]);
    const hook = view.cdpCalls.find((call) => call.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(hook?.params?.source).toBe(COMIX_CAPTURE_BOOTSTRAP);
    expect(view.cookies[0]).toMatchObject({ name: "cf_clearance", value: "tok" });
  });

  it("returns captured browse items and harvests the jar", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view });
    const browse = "https://comix.to/browse?page=1&keyword=solo+leveling";
    view.pages.set(browse, {
      title: "Browse",
      html: "<main>results</main>",
      payload: { r: { result: { items: [{ hid: "abc", title: "Solo Leveling" }] } } },
    });
    view.cookies = [{ name: "cf_clearance", value: "fresh", domain: ".comix.to", expires: 1_800_000_000 }];

    expect(await browser.search("solo leveling")).toEqual([{ hid: "abc", title: "Solo Leveling" }]);
    expect(await browser.harvest()).toEqual({
      cookies: [{ name: "cf_clearance", value: "fresh", domain: ".comix.to", expires: 1_800_000_000 }],
      userAgent: "Mozilla/5.0 Chrome/126",
    });
  });

  it("treats a challenge page as a session failure, not a miss", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view });
    view.pages.set("https://comix.to/browse?page=1&keyword=naruto", {
      title: "Just a moment...",
      html: "<div id=\"challenge-platform\"></div>",
      payload: { r: { result: { items: [{ hid: "should-not-use" }] } } },
    });
    expect(await browser.search("naruto")).toBe("challenge");
  });

  it("treats a timed-out capture as a challenge", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view });
    view.pages.set("https://comix.to/browse?page=1&keyword=bleach", {
      title: "Browse",
      html: "<main></main>",
      payload: { r: null },
    });
    expect(await browser.search("bleach")).toBe("challenge");
  });
});
