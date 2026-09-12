/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { isJsonArray, isJsonObject, isString, type JsonValue } from "@manifold/json";

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

export const chaptersFromWebView = (value: JsonValue): readonly WebViewChapter[] => {
  const root = isJsonObject(value) ? value : undefined;
  const chapters = isJsonArray(root?.chapters) ? root.chapters : [];
  return chapters
    .map((item) => (isJsonObject(item) ? item : undefined))
    .map((item): WebViewChapter | undefined => {
      const url = isString(item?.url) ? item.url : "";
      const title = isString(item?.title) ? item.title : "";
      return url ? { url, title: title || undefined } : undefined;
    })
    .filter((item): item is WebViewChapter => item !== undefined);
};

export const pagesFromWebView = (value: JsonValue): readonly string[] => {
  const root = isJsonObject(value) ? value : undefined;
  const pages = isJsonArray(root?.pages) ? root.pages : [];
  return pages.filter(isString).filter((url) => url.length > 0);
};
