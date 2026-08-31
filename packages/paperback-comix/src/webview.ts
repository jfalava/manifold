import type { JsonObject } from "./parser.js";

export type WebViewChapter = {
  readonly url: string;
  readonly title?: string;
};

const webViewScript = (mode: "chapters" | "pages"): string => `
(() => {
  const mode = ${JSON.stringify(mode)};
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const absoluteUrl = (value) => {
    try { return new URL(value, document.baseURI).href; } catch (_) { return value; }
  };

  const chapterLinks = () => Array.from(document.querySelectorAll("a[href]"))
    .map((element) => ({
      url: absoluteUrl(element.getAttribute("href") || ""),
      title: (element.textContent || "").replace(/\\s+/g, " ").trim(),
    }))
    .filter((item) => /\\/(?:chapter\\/\\d+|title\\/[^?#/]+\\/\\d+[^/?#]*)/i.test(item.url));

  const pageImages = () => Array.from(document.querySelectorAll("img"))
    .map((element) => element.getAttribute("src") || element.getAttribute("data-src") || "")
    .map(absoluteUrl)
    .filter((url) => url && /\\/(?:i|si|images?)\\//i.test(url) && !/poster|logo|avatar|favicon/i.test(url));

  return (async () => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const chapters = mode === "chapters" ? chapterLinks() : [];
      const pages = mode === "pages" ? pageImages() : [];
      if (chapters.length > 0 || pages.length > 0) return { chapters, pages };
      await wait(250);
    }
    return {
      chapters: mode === "chapters" ? chapterLinks() : [],
      pages: mode === "pages" ? pageImages() : [],
    };
  })();
})()
`;

export const chaptersWebViewScript = webViewScript("chapters");
export const pagesWebViewScript = webViewScript("pages");

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string => typeof value === "string" ? value : "";

export const chaptersFromWebView = (value: unknown): readonly WebViewChapter[] => {
  const root = asObject(value);
  return asArray(root?.chapters)
    .map(asObject)
    .map((item): WebViewChapter | undefined => {
      const url = asString(item?.url);
      return url ? { url, title: asString(item?.title) || undefined } : undefined;
    })
    .filter((item): item is WebViewChapter => item !== undefined);
};

export const pagesFromWebView = (value: unknown): readonly string[] => {
  const root = asObject(value);
  return asArray(root?.pages)
    .map(asString)
    .filter((url) => url.length > 0);
};
