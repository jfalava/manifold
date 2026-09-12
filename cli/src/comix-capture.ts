/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isJsonObject,
  isString,
  stringField,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";

import {
  COMIX_ORIGIN,
  comixBrowseUrl,
  googleComixSearchUrl,
  comixItemFromGoogleLink,
  googleGotoLinks,
  isChallengeText,
  isComixPageUrl,
  isGoogleBlockedPage,
  isGoogleResultsUrl,
  itemsFromCapture,
  itemsFromGoogleLinks,
  type ComixSearchItem,
} from "./comix-match";
import { cookiesFromCdp, toCdpCookie, type ComixCookie } from "./comix-session";

export const CAPTURE_TIMEOUT_MS = 15_000;
export const GOOGLE_POLL_INTERVAL_MS = 500;
export const GOTO_FOLLOW_LIMIT = 3;
export const GOTO_REDIRECT_TIMEOUT_MS = 10_000;
export const CHROME_DEBUG_PORT = 9222;

export interface ComixView {
  readonly title: string;
  readonly url: string;
  navigate: (url: string) => Promise<void>;
  evaluate: <T = JsonValue>(script: string) => Promise<T>;
  cdp: <T = JsonValue>(method: string, params?: JsonObject) => Promise<T>;
  close: () => void;
}

export interface ComixBrowser {
  readonly search: (keyword: string) => Promise<readonly ComixSearchItem[] | "challenge">;
  readonly searchGoogle: (keyword: string) => Promise<readonly ComixSearchItem[] | "challenge">;
  readonly harvest: () => Promise<{ cookies: ComixCookie[]; userAgent?: string }>;
  readonly close: () => void;
}

export const comixProfileDir = (home = homedir()): string =>
  join(home, ".manifold", "comix-chrome");

export const parseDevToolsActivePort = (
  contents: string,
  host = "127.0.0.1",
): string | undefined => {
  const [portLine, pathLine] = contents.split(/\r?\n/);
  const port = portLine?.trim();
  const path = pathLine?.trim();
  if (!port || !/^\d+$/.test(port) || !path || path.length === 0) {
    return undefined;
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `ws://${host}:${port}${suffix}`;
};

export const chromeDevToolsPortCandidates = (
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): string[] => {
  const localAppData = env.LOCALAPPDATA;
  return [
    join(comixProfileDir(home), "DevToolsActivePort"),
    join(home, "Library/Application Support/Google/Chrome/DevToolsActivePort"),
    join(home, "Library/Application Support/Google/Chrome Canary/DevToolsActivePort"),
    join(home, "Library/Application Support/Chromium/DevToolsActivePort"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort"),
    join(home, "Library/Application Support/Microsoft Edge/DevToolsActivePort"),
    join(home, ".config/google-chrome/DevToolsActivePort"),
    join(home, ".config/chromium/DevToolsActivePort"),
    join(home, ".config/brave-browser/DevToolsActivePort"),
    join(home, ".config/microsoft-edge/DevToolsActivePort"),
    ...(localAppData
      ? [
          join(localAppData, "Google/Chrome/User Data/DevToolsActivePort"),
          join(localAppData, "Chromium/User Data/DevToolsActivePort"),
          join(localAppData, "BraveSoftware/Brave-Browser/User Data/DevToolsActivePort"),
          join(localAppData, "Microsoft/Edge/User Data/DevToolsActivePort"),
        ]
      : []),
  ];
};

export const findChromeDevToolsUrl = (
  candidates = chromeDevToolsPortCandidates(),
  readFile: (file: string) => string | undefined = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
): string | undefined => {
  for (const file of candidates) {
    const contents = readFile(file);
    if (!contents) {
      continue;
    }
    const url = parseDevToolsActivePort(contents);
    if (url) {
      return url;
    }
  }
  return undefined;
};

export const parseChromeVersionEndpoint = (body: string): string | undefined => {
  try {
    // SAFETY: Chrome /json/version body is decoded via isJsonObject/stringField
    const parsed: unknown = JSON.parse(body);
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    const url = stringField(parsed, "webSocketDebuggerUrl");
    return url !== undefined && url.startsWith("ws://") ? url : undefined;
  } catch {
    return undefined;
  }
};

export const chromeExecutableCandidates = (home = homedir()): string[] => [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export const findChromeExecutable = (
  candidates = chromeExecutableCandidates(),
  exists: (path: string) => boolean = existsSync,
): string | undefined => candidates.find((path) => exists(path));

export const chromeLaunchArgs = (profileDir: string, port = CHROME_DEBUG_PORT): string[] => [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  `${COMIX_ORIGIN}/`,
];

export const launchComixChrome = (options: {
  readonly executable: string;
  readonly profileDir?: string;
  readonly port?: number;
}): void => {
  spawn(
    options.executable,
    chromeLaunchArgs(options.profileDir ?? comixProfileDir(), options.port ?? CHROME_DEBUG_PORT),
    { detached: true, stdio: "ignore" },
  ).unref();
};

export const probeChromeDevToolsUrl = async (
  ports: readonly number[] = [CHROME_DEBUG_PORT],
  fetchVersion: (url: string) => Promise<string | undefined> = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) {
        return undefined;
      }
      return await response.text();
    } catch {
      return undefined;
    }
  },
): Promise<string | undefined> => {
  const fromFile = findChromeDevToolsUrl();
  if (fromFile) {
    return fromFile;
  }
  for (const port of ports) {
    const body = await fetchVersion(`http://127.0.0.1:${port}/json/version`);
    if (!body) {
      continue;
    }
    const url = parseChromeVersionEndpoint(body);
    if (url) {
      return url;
    }
  }
  return undefined;
};

export const waitForChromeDevToolsUrl = async (
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly probe?: () => Promise<string | undefined>;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | undefined> => {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 400;
  const probe = options.probe ?? probeChromeDevToolsUrl;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  while (true) {
    const url = await probe();
    if (url) {
      return url;
    }
    if (now() >= deadline) {
      return undefined;
    }
    await sleep(intervalMs);
  }
};

// Injected before every navigation so JSON.parse of the site's own signed
// /api/v1 responses is captured even though the CLI never fetches them.
export const COMIX_CAPTURE_BOOTSTRAP = `
(function(){
  if (window.__comixHooked__) return;
  window.__comixHooked__ = true;
  var done = false;
  var doneResolve;
  window.__comixResult__ = new Promise(function(resolve){ doneResolve = resolve; });
  function finish(value){
    if (done) return;
    done = true;
    doneResolve({ r: value });
  }
  var orig = JSON.parse;
  JSON.parse = new Proxy(orig, {
    apply: function(target, thisArg, args){
      var parsed = Reflect.apply(target, thisArg, args);
      try {
        if (done) return parsed;
        var result = parsed && parsed.result;
        if (result && Array.isArray(result.items)) finish(args[0]);
      } catch (error) {}
      return parsed;
    }
  });
  setTimeout(function(){ finish(null); }, ${CAPTURE_TIMEOUT_MS});
})();
`;

export const classifyPage = (title: string, html: string): "ok" | "challenge" =>
  isChallengeText(title) || isChallengeText(html) ? "challenge" : "ok";

const SNAPSHOT_SCRIPT =
  "({ title: document.title, html: document.documentElement.outerHTML.slice(0, 4000), ua: navigator.userAgent })";

// One evaluate per poll: navigation resolves before Google renders results,
// so searchGoogle re-runs this until comix.to anchors appear or time runs out.
const GOOGLE_SNAPSHOT_SCRIPT =
  "({ url: location.href, ready: document.readyState, title: document.title, " +
  'links: Array.from(document.querySelectorAll(\'a[href*="comix.to"], a[href*="/goto?"]\'), ' +
  "function(anchor){ return { href: anchor.href, title: anchor.textContent || '' }; }) })";

export const createComixBrowser = async (options: {
  readonly view: ComixView;
  readonly cookies?: readonly ComixCookie[];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<ComixBrowser> => {
  const { view } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await view.navigate("about:blank");
  await view.cdp("Page.enable");
  await view.cdp("Network.enable");
  await view.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: COMIX_CAPTURE_BOOTSTRAP,
  });
  if (options.cookies && options.cookies.length > 0) {
    await view.cdp("Network.setCookies", {
      cookies: options.cookies.map(toCdpCookie),
    });
  }

  const harvest = async (): Promise<{ cookies: ComixCookie[]; userAgent?: string }> => {
    const raw = await view.cdp("Network.getCookies", { urls: [`${COMIX_ORIGIN}/`] });
    const cookies = cookiesFromCdp(raw).filter((cookie) => {
      const domain = (cookie.domain ?? "").replace(/^\./, "");
      return domain.length === 0 || domain === "comix.to" || domain.endsWith(".comix.to");
    });
    let userAgent: string | undefined;
    try {
      const ua = await view.evaluate("navigator.userAgent");
      if (isString(ua) && ua.length > 0) {
        userAgent = ua;
      }
    } catch {
      // harvest cookies even if the tab is mid-navigation
    }
    return { cookies, userAgent };
  };

  const search = async (keyword: string): Promise<readonly ComixSearchItem[] | "challenge"> => {
    await view.navigate(comixBrowseUrl(keyword));
    const snapshot = await view.evaluate(SNAPSHOT_SCRIPT);
    const record = isJsonObject(snapshot) ? snapshot : undefined;
    const title = record === undefined ? view.title : (stringField(record, "title") ?? view.title);
    const html = record === undefined ? "" : (stringField(record, "html") ?? "");
    if (classifyPage(title, html) === "challenge") {
      return "challenge";
    }
    const payload = await view.evaluate("window.__comixResult__");
    return itemsFromCapture(payload) ?? "challenge";
  };

  const searchGoogle = async (
    keyword: string,
  ): Promise<readonly ComixSearchItem[] | "challenge"> => {
    await view.navigate(googleComixSearchUrl(keyword));
    const deadline = now() + CAPTURE_TIMEOUT_MS;
    let completedPolls = 0;
    while (true) {
      const snapshot = await view.evaluate(GOOGLE_SNAPSHOT_SCRIPT);
      const record = isJsonObject(snapshot) ? snapshot : undefined;
      const url = record === undefined ? view.url : (stringField(record, "url") ?? view.url);
      const title =
        record === undefined ? view.title : (stringField(record, "title") ?? view.title);
      if (isGoogleBlockedPage(url, title)) {
        return "challenge";
      }
      // Page.navigate resolves when navigation starts, so early polls still see
      // the previous document (often a comix.to page full of comix.to anchors).
      // Only read anchors once the WebView is actually on Google results.
      if (isGoogleResultsUrl(url) && record !== undefined) {
        const items = itemsFromGoogleLinks(record.links ?? null);
        if (items.length > 0) {
          return items;
        }
        const ready = stringField(record, "ready") ?? "";
        if (ready === "complete") {
          completedPolls += 1;
          // Google's udm=14 view wraps results in opaque /goto redirects; the
          // only way to recover the comix.to URL is to follow one.
          const gotoLinks = googleGotoLinks(record.links ?? null);
          if (gotoLinks.length > 0) {
            return followGotoLinks(gotoLinks);
          }
          // Results are server-rendered, so two empty polls on a complete
          // page mean a real miss.
          if (completedPolls >= 2) {
            return [];
          }
        }
      }
      if (now() >= deadline) {
        return [];
      }
      await sleep(GOOGLE_POLL_INTERVAL_MS);
    }
  };

  const followGotoLinks = async (
    links: readonly { readonly href: string; readonly title: string }[],
  ): Promise<readonly ComixSearchItem[] | "challenge"> => {
    for (const link of links.slice(0, GOTO_FOLLOW_LIMIT)) {
      await view.navigate(link.href);
      const deadline = now() + GOTO_REDIRECT_TIMEOUT_MS;
      while (true) {
        const href = await view.evaluate("location.href");
        const current = isString(href) ? href : view.url;
        if (isGoogleBlockedPage(current, "")) {
          return "challenge";
        }
        const item = comixItemFromGoogleLink(current, link.title);
        if (item !== undefined) {
          return [item];
        }
        // Landed on comix.to but not a /title/ page: try the next link.
        if (isComixPageUrl(current)) {
          break;
        }
        if (now() >= deadline) {
          break;
        }
        await sleep(GOOGLE_POLL_INTERVAL_MS);
      }
    }
    return [];
  };

  return {
    search,
    searchGoogle,
    harvest,
    close: () => view.close(),
  };
};

export const openBunComixView = (options: {
  readonly chromeUrl: string;
  readonly profileDir?: string;
}): ComixView =>
  new Bun.WebView({
    width: 1280,
    height: 800,
    backend: { type: "chrome", url: options.chromeUrl },
    dataStore: { directory: options.profileDir ?? comixProfileDir() },
  });
