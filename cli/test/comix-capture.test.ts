/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics schemaSync:off */
import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "@manifold/json";

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
import { cookiesFromCdp, type ComixCookie } from "../src/comix-session";

class FakeView implements ComixView {
  title = "";
  url = "";
  navigations: string[] = [];
  cdpCalls: { method: string; params?: JsonObject }[] = [];
  cookies: ComixCookie[] = [];
  closed = false;
  googlePolls = 0;
  pages = new Map<
    string,
    {
      title: string;
      html: string;
      payload: JsonValue;
      ready?: string;
      linksAfterPolls?: number;
    }
  >();

  /** Polls the old document until navigation "lands", like real Page.navigate. */
  navDelayPolls = 0;
  /** Simulates HTTP redirects (e.g. Google /goto → comix.to title URL). */
  redirects = new Map<string, string>();
  private pendingNav?: { url: string; remaining: number };

  async navigate(next: string): Promise<void> {
    this.navigations.push(next);
    const target = this.redirects.get(next) ?? next;
    if (this.navDelayPolls > 0) {
      this.pendingNav = { url: target, remaining: this.navDelayPolls };
    } else {
      this.url = target;
    }
    this.title = this.pages.get(this.url)?.title ?? "";
  }

  async evaluate<T = JsonValue>(script: string): Promise<T> {
    if (script.includes("querySelectorAll") && this.pendingNav !== undefined) {
      this.pendingNav.remaining -= 1;
      if (this.pendingNav.remaining <= 0) {
        this.url = this.pendingNav.url;
        this.title = this.pages.get(this.url)?.title ?? "";
        this.pendingNav = undefined;
      }
    }
    const page = this.pages.get(this.url);
    if (script.includes("querySelectorAll")) {
      this.googlePolls += 1;
      // SAFETY: value matches T at this call site
      return {
        url: this.url,
        ready: page?.ready ?? "complete",
        title: page?.title ?? this.title,
        links: this.googlePolls > (page?.linksAfterPolls ?? 0) ? (page?.payload ?? []) : [],
      } as T;
    }
    if (script.includes("document.title")) {
      // SAFETY: value matches T at this call site
      return {
        title: page?.title ?? this.title,
        html: page?.html ?? "",
        ua: "Mozilla/5.0 Chrome/126",
      } as T;
    }
    if (script.includes("navigator.userAgent")) {
      // SAFETY: value matches T at this call site
      return "Mozilla/5.0 Chrome/126" as T;
    }
    if (script.includes("location.href")) {
      // SAFETY: value matches T at this call site
      return this.url as T;
    }
    if (script.includes("__comixResult__")) {
      // SAFETY: value matches T at this call site
      return page?.payload as T;
    }
    throw new Error(`unexpected evaluate: ${script}`);
  }

  async cdp<T = JsonValue>(method: string, params?: JsonObject): Promise<T> {
    this.cdpCalls.push({ method, params });
    if (method === "Network.setCookies") {
      this.cookies = params === undefined ? [] : cookiesFromCdp(params);
      // SAFETY: value matches T at this call site
      return {} as T;
    }
    if (method === "Network.getCookies") {
      // SAFETY: value matches T at this call site
      return { cookies: this.cookies } as T;
    }
    // SAFETY: value matches T at this call site
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
      findChromeDevToolsUrl(["/missing", "/chrome/DevToolsActivePort"], (file) =>
        file.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/live" : undefined,
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
    expect(classifyPage("Browse", '<div class="cf-chl-widget"></div>')).toBe("challenge");
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
    const hook = view.cdpCalls.find(
      (call) => call.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(hook?.params?.source).toBe(COMIX_CAPTURE_BOOTSTRAP);
    expect(view.cookies[0]).toMatchObject({ name: "cf_clearance", value: "tok" });
  });

  it("returns captured browse items and harvests the jar", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view });
    const browse =
      "https://comix.to/browse?q=solo%20leveling&sort=relevance%3Adesc&content_rating=safe%2Csuggestive%2Cerotica%2Cpornographic";
    view.pages.set(browse, {
      title: "Browse",
      html: "<main>results</main>",
      payload: { r: { result: { items: [{ hid: "abc", title: "Solo Leveling" }] } } },
    });
    view.cookies = [
      { name: "cf_clearance", value: "fresh", domain: ".comix.to", expires: 1_800_000_000 },
    ];

    expect(await browser.search("solo leveling")).toEqual([{ hid: "abc", title: "Solo Leveling" }]);
    expect(await browser.harvest()).toEqual({
      cookies: [
        { name: "cf_clearance", value: "fresh", domain: ".comix.to", expires: 1_800_000_000 },
      ],
      userAgent: "Mozilla/5.0 Chrome/126",
    });
  });

  it("treats a challenge page as a session failure, not a miss", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view });
    view.pages.set(
      "https://comix.to/browse?q=naruto&sort=relevance%3Adesc&content_rating=safe%2Csuggestive%2Cerotica%2Cpornographic",
      {
        title: "Just a moment...",
        html: '<div id="challenge-platform"></div>',
        payload: { r: { result: { items: [{ hid: "should-not-use" }] } } },
      },
    );
    expect(await browser.search("naruto")).toBe("challenge");
  });

  it("treats a timed-out capture as a challenge", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view });
    view.pages.set(
      "https://comix.to/browse?q=bleach&sort=relevance%3Adesc&content_rating=safe%2Csuggestive%2Cerotica%2Cpornographic",
      {
        title: "Browse",
        html: "<main></main>",
        payload: { r: null },
      },
    );
    expect(await browser.search("bleach")).toBe("challenge");
  });

  it("extracts Comix title results from the Google fallback", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view, sleep: async () => undefined });
    const google =
      "https://www.google.com/search?q=Genkaku%20Shoujo%20ga%20Tsukimatou%20site%3Acomix.to&udm=14&num=20&hl=en";
    view.pages.set(google, {
      title: "Genkaku Shoujo ga Tsukimatou - Google Search",
      html: "<main>results</main>",
      payload: [
        {
          href: "https://comix.to/title/3el2-genkaku-shoujo-ga-tsukimatou-hanashi",
          title: "Genkaku Shoujo ga Tsukimatou Hanashi",
        },
      ],
    });

    expect(await browser.searchGoogle("Genkaku Shoujo ga Tsukimatou")).toEqual([
      {
        hid: "3el2",
        slug: "genkaku-shoujo-ga-tsukimatou-hanashi",
        title: "Genkaku Shoujo ga Tsukimatou Hanashi",
      },
    ]);
  });

  it("polls until Google renders the results", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view, sleep: async () => undefined });
    const google =
      "https://www.google.com/search?q=Monesan%20no%20Majime%20Sugiru%20Tsukiaikata%20site%3Acomix.to&udm=14&num=20&hl=en";
    view.pages.set(google, {
      title: "Monesan no Majime Sugiru Tsukiaikata - Google Search",
      html: "<main>results</main>",
      ready: "loading",
      linksAfterPolls: 2,
      payload: [
        { href: "https://comix.to/title/1y7gl", title: "Monesan no Majime Sugiru Tsukiaikata" },
      ],
    });

    expect(await browser.searchGoogle("Monesan no Majime Sugiru Tsukiaikata")).toEqual([
      { hid: "1y7gl", title: "Monesan no Majime Sugiru Tsukiaikata" },
    ]);
    expect(view.googlePolls).toBe(3);
  });

  it("treats Google's captcha and consent interstitials as challenges", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view, sleep: async () => undefined });
    view.pages.set("https://www.google.com/search?q=naruto%20site%3Acomix.to&udm=14&num=20&hl=en", {
      title: "Before you continue",
      html: "<main></main>",
      payload: [],
    });
    expect(await browser.searchGoogle("naruto")).toBe("challenge");
  });

  it("reports a miss after two empty polls on a complete Google page", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view, sleep: async () => undefined });
    view.pages.set("https://www.google.com/search?q=bleach%20site%3Acomix.to&udm=14&num=20&hl=en", {
      title: "bleach - Google Search",
      html: "<main></main>",
      payload: [],
    });
    expect(await browser.searchGoogle("bleach")).toEqual([]);
    expect(view.googlePolls).toBe(2);
  });

  it("follows Google's opaque /goto redirects to recover the comix.to URL", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view, sleep: async () => undefined });
    const google =
      "https://www.google.com/search?q=Makenshi%20no%20Maken%20Niyoru%20Maken%20no%20Tame%20no%20Harem%20Life%20site%3Acomix.to&udm=14&num=20&hl=en";
    const goto = "https://www.google.com/goto?url=CAESmwEB6zswFeLyVY8SSskW8AXXhWr07BLznVi7";
    view.pages.set(google, {
      title: "Makenshi no Maken Niyoru Maken no Tame no Harem Life - Google Search",
      html: "<main>results</main>",
      payload: [{ href: goto, title: "Makenshi no Maken Niyoru Maken no Tame no Harem Life" }],
    });
    view.redirects.set(
      goto,
      "https://comix.to/title/y9j2n-makenshi-no-maken-niyoru-maken-no-tame-no-harem-life/7529993-chapter-1",
    );

    expect(
      await browser.searchGoogle("Makenshi no Maken Niyoru Maken no Tame no Harem Life"),
    ).toEqual([
      {
        hid: "y9j2n",
        slug: "makenshi-no-maken-niyoru-maken-no-tame-no-harem-life",
        title: "Makenshi no Maken Niyoru Maken no Tame no Harem Life",
      },
    ]);
  });

  it("ignores the previous page's comix anchors until Google actually loads", async () => {
    const view = new FakeView();
    const browser = await createComixBrowser({ view, sleep: async () => undefined });
    // The stale document from the last comix.to browse search, full of anchors.
    view.url = "https://comix.to/browse?q=stale&sort=relevance%3Adesc";
    view.pages.set(view.url, {
      title: "Browse",
      html: "<main>old results</main>",
      payload: [{ href: "https://comix.to/title/stale-old-result", title: "Old Result" }],
    });
    const google =
      "https://www.google.com/search?q=Monesan%20no%20Majime%20Sugiru%20Tsukiaikata%20site%3Acomix.to&udm=14&num=20&hl=en";
    view.pages.set(google, {
      title: "Monesan no Majime Sugiru Tsukiaikata - Google Search",
      html: "<main>results</main>",
      payload: [
        { href: "https://comix.to/title/1y7gl", title: "Monesan no Majime Sugiru Tsukiaikata" },
      ],
    });
    view.navDelayPolls = 3;

    expect(await browser.searchGoogle("Monesan no Majime Sugiru Tsukiaikata")).toEqual([
      { hid: "1y7gl", title: "Monesan no Majime Sugiru Tsukiaikata" },
    ]);
  });
});
