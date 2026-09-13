/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContentRating,
  type Cookie,
  type Request,
  type Response,
  type SourceManga,
} from "@paperback/types";

const savedCookie = (): Cookie => ({
  name: "cf_clearance",
  value: "existing-clearance",
  domain: "comix.to",
  path: "/",
  expires: new Date(Date.now() + 60_000),
});

describe("Comix cookie callbacks", () => {
  let stored: Cookie[];
  let setState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    stored = [savedCookie()];
    setState = vi.fn((value: Cookie[]) => {
      stored = value;
    });
    Object.assign(globalThis, {
      Application: {
        getState: () => stored,
        setState,
      },
    });
  });

  afterEach(() => {
    Object.assign(globalThis, { Application: undefined });
    vi.restoreAllMocks();
  });

  it("preserves the stored clearance when Paperback reports an empty harvest", async () => {
    const { ComixSource } = await import("../src/index.js");
    const source = new ComixSource();
    const request = {
      url: "https://comix.to/",
      method: "GET",
      headers: {},
    } satisfies Request;

    await source.cloudflareBypassCompleted(request, [], {});

    expect(source.hasSavedComixCookies()).toBe(true);
    expect(setState).not.toHaveBeenCalled();
    expect(stored).toEqual([expect.objectContaining({ value: "existing-clearance" })]);
  });

  it("ignores non-Comix cookies instead of replacing the local jar", async () => {
    const { ComixSource } = await import("../src/index.js");
    const source = new ComixSource();
    const unrelated: Cookie = {
      name: "session",
      value: "other-site",
      domain: "example.com",
      path: "/",
      expires: new Date(Date.now() + 60_000),
    };

    await source.saveCloudflareBypassCookies([unrelated]);

    expect(source.hasSavedComixCookies()).toBe(true);
    expect(setState).not.toHaveBeenCalled();
    expect(stored).toEqual([expect.objectContaining({ value: "existing-clearance" })]);
  });

  it("preserves the jar when a WebView returns an empty cookie storage", async () => {
    Object.assign(globalThis, {
      Application: {
        getState: () => stored,
        setState,
        scheduleRequest: vi.fn(async () => {
          const response = {
            url: "https://comix.to/api/v1/manga/123/chapters",
            headers: {},
            status: 200,
            cookies: [],
          } satisfies Response;
          return [response, new ArrayBuffer(0)] as const;
        }),
        arrayBufferToUTF8String: vi.fn(() => "{}"),
        executeInWebView: vi.fn(async () => ({
          result: { chapters: [], pages: [] },
          storage: { cookies: [] },
        })),
      },
    });
    const { ComixSource } = await import("../src/index.js");
    const source = new ComixSource();
    const manga = {
      mangaId: "123-title",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Title",
        secondaryTitles: [],
        contentRating: ContentRating.EVERYONE,
      },
    } satisfies SourceManga;

    expect(await source.getChapters(manga)).toEqual([]);
    expect(source.hasSavedComixCookies()).toBe(true);
    expect(setState).not.toHaveBeenCalled();
  });
});
