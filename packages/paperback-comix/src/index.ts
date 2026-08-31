import {
  BasicRateLimiter,
  CloudflareError,
  ContentRating,
  CookieStorageInterceptor,
  Form,
  FlowSection,
  LabelRow,
  WebViewRow,
  SourceIntents,
  type ChapterProviding,
  type Extension,
  type CloudflareBypassRequestProviding,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type ExtensionInfo,
  type Metadata,
  type PagedResults,
  type Request,
  type Response as PaperbackResponse,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";
import {
  hashIdFromMangaId,
  paginationFromPayload,
  resultItems,
  toChapter,
  toChapterDetails,
  toSearchResult,
  toSourceManga,
  type ComixCaptureBody,
} from "./parser.js";
import {
  chaptersFromWebView,
  chaptersWebViewScript,
  pagesFromWebView,
  pagesWebViewScript,
} from "./webview.js";

export const COMIX_ORIGIN = "https://comix.to";

export const ComixInfo: ExtensionInfo = {
  version: "0.1.0",
  name: "Comix",
  icon: "icon.svg",
  description: "Comix source with device-local Cloudflare cookie storage.",
  contentRating: ContentRating.MATURE,
  developers: [{ name: "manifold" }],
  language: "en",
  badges: [{ label: "beta", textColor: "#ffffff", backgroundColor: "#7c3aed" }],
  capabilities: [
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
};

type JsonRequest = {
  readonly url: string;
  readonly body: ComixCaptureBody;
};

type HtmlRequest = {
  readonly url: string;
  readonly html: string;
};

const requestFor = (url: string): Request => ({
  url,
  method: "GET",
  headers: {
    Accept: "application/json, text/plain, */*",
    Referer: `${COMIX_ORIGIN}/`,
  },
});

const isChallenge = (body: string): boolean => {
  const normalized = body.toLowerCase();
  return normalized.includes("just a moment") ||
    normalized.includes("cf-chl-") ||
    normalized.includes("challenge-platform") ||
    normalized.includes("_cf_chl_");
};

const requestJson = async (url: string): Promise<JsonRequest> => {
  const request = requestFor(url);
  const [response, bodyBuffer] = await Application.scheduleRequest(request);
  const body = Application.arrayBufferToUTF8String(bodyBuffer);

  if (response.status === 403 || response.status === 503 || isChallenge(body)) {
    throw new CloudflareError(request, `Comix blocked ${url} with a Cloudflare challenge`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Comix request failed with HTTP ${response.status}: ${url}`);
  }

  try {
    // SAFETY: Response body is untyped JSON at the HTTP boundary; ComixCaptureBody is the domain parse target.
    return { url, body: JSON.parse(body) as ComixCaptureBody };
  } catch {
    throw new Error(`Comix returned a non-JSON response: ${url}`);
  }
};

const requestHtml = async (url: string): Promise<HtmlRequest> => {
  const request = requestFor(url);
  const [response, bodyBuffer] = await Application.scheduleRequest({
    ...request,
    headers: {
      ...request.headers,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const html = Application.arrayBufferToUTF8String(bodyBuffer);

  if (response.status === 403 || response.status === 503 || isChallenge(html)) {
    throw new CloudflareError(request, `Comix blocked ${url} with a Cloudflare challenge`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Comix page request failed with HTTP ${response.status}: ${url}`);
  }

  return { url, html };
};

const pageFromMetadata = (metadata: Metadata | undefined): number => {
  if (typeof metadata === "number" && Number.isFinite(metadata)) {return metadata;}
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
    const page = (metadata as Record<string, unknown>).page;
    if (typeof page === "number" && Number.isFinite(page)) {return page;}
  }
  return 1;
};

const nextMetadata = (current: number, last: number | undefined): Metadata | undefined =>
  last !== undefined && current < last ? { page: current + 1 } : undefined;

/**
 * Cookie jar that never learns from failed responses: a 403/503 challenge
 * carries Set-Cookie that would otherwise overwrite a still-valid
 * `cf_clearance` and force a fresh bypass for every subsequent request.
 */
class SafeCookieStorage extends CookieStorageInterceptor {
  constructor() {
    super({ storage: "stateManager" });
  }

  override async interceptResponse(
    request: Request,
    response: PaperbackResponse,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (response.status >= 400 || response.headers?.["cf-mitigated"] === "challenge") {
      return data;
    }
    return super.interceptResponse(request, response, data);
  }
}

export class ComixSource implements
  Extension,
  SearchResultsProviding,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  SettingsFormProviding {
  /**
   * Cookie jar that never learns from failed responses: a 403/503 challenge
   * carries Set-Cookie that would otherwise overwrite a still-valid
   * `cf_clearance` and force a fresh bypass for every subsequent request.
   */
  private readonly cookieStorage = new SafeCookieStorage();

  private readonly rateLimiter = new BasicRateLimiter("comix-rate", {
    numberOfRequests: 2,
    bufferInterval: 1,
    ignoreImages: true,
  });

  async initialise(): Promise<void> {
    this.cookieStorage.registerInterceptor();
    this.rateLimiter.registerInterceptor();
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    this.cookieStorage.cookies = cookies;
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    this.cookieStorage.cookies = cookies;
  }

  async getSettingsForm(): Promise<Form> {
    return new ComixSettingsForm(this);
  }

  hasSavedComixCookies(): boolean {
    return this.cookieStorage.cookies.some((cookie) =>
      cookie.domain === "comix.to" || cookie.domain.endsWith(".comix.to"),
    );
  }

  private async executeComixWebView(
    url: string,
    inject: string,
  ): Promise<ComixCaptureBody> {
    const page = await requestHtml(url);
    const execution = await Application.executeInWebView({
      source: {
        html: page.html,
        baseUrl: page.url,
        loadCSS: false,
        loadImages: true,
      },
      inject,
      storage: { cookies: [...this.cookieStorage.cookies] },
    });
    this.cookieStorage.cookies = execution.storage.cookies;
    // SAFETY: WebView inject result is untyped at the boundary; ComixCaptureBody is the domain parse target.
    return execution.result as ComixCaptureBody;
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = pageFromMetadata(metadata);
    const url = new URL("/api/v1/manga", COMIX_ORIGIN);
    url.searchParams.set("keyword", query.title.trim());
    url.searchParams.set("page", String(page));

    const response = await requestJson(url.toString());
    const items = resultItems(response.body);
    const pagination = paginationFromPayload(response.body);

    return {
      items: items.map(toSearchResult),
      metadata: nextMetadata(page, pagination.lastPage),
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const hashId = hashIdFromMangaId(mangaId);
    const response = await requestJson(`${COMIX_ORIGIN}/api/v1/manga/${encodeURIComponent(hashId)}`);
    const items = resultItems(response.body);
    // SAFETY: value is Record<string at this site
    const item = items[0] ?? (
      typeof response.body === "object" && response.body !== null
        // SAFETY: test/double or boundary cast through unknown to Record<string, unknown> | undefined
        ? ((response.body as Record<string, unknown>).result as Record<string, unknown> | undefined)
        : undefined
    );

    if (!item) {throw new Error(`Comix manga not found: ${mangaId}`);}
    return { ...toSourceManga(item), mangaId };
  }

  async getChapters(sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
    const hashId = hashIdFromMangaId(sourceManga.mangaId);
    const response = await requestJson(
      `${COMIX_ORIGIN}/api/v1/manga/${encodeURIComponent(hashId)}/chapters`,
    );
    const apiChapters = resultItems(response.body);
    if (apiChapters.length > 0) {return apiChapters.map((item) => toChapter(item, sourceManga));}

    const webViewResult = await this.executeComixWebView(
      `${COMIX_ORIGIN}/title/${encodeURIComponent(sourceManga.mangaId)}`,
      chaptersWebViewScript,
    );
    return chaptersFromWebView(webViewResult).map((item) =>
      toChapter({ url: item.url, title: item.title }, sourceManga),
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const response = await requestJson(
      `${COMIX_ORIGIN}/api/v1/chapters/${encodeURIComponent(chapter.chapterId)}`,
    );
    try {
      return toChapterDetails(response.body, chapter);
    } catch {
      const chapterUrl = chapter.additionalInfo?.["Comix chapter URL"] ??
        `${COMIX_ORIGIN}/chapter/${encodeURIComponent(chapter.chapterId)}`;
      const webViewResult = await this.executeComixWebView(
        new URL(chapterUrl, COMIX_ORIGIN).href,
        pagesWebViewScript,
      );
      const pages = pagesFromWebView(webViewResult);
      if (pages.length === 0) {
        throw new Error(`Comix did not expose readable pages for chapter ${chapter.chapterId}`);
      }
      return {
        id: chapter.chapterId,
        mangaId: chapter.sourceManga.mangaId,
        type: "images",
        pages: [...pages],
      };
    }
  }
}

class ComixSettingsForm extends Form {
  readonly requiresExplicitSubmission = false;

  constructor(private readonly source: ComixSource) {
    super();
  }

  getSections() {
    const status = this.source.hasSavedComixCookies()
      ? "Comix browser session is ready on this device."
      : "Open Comix once to complete its browser check.";

    return [
      FlowSection(
        {
          id: "comix-access",
          header: "Comix access",
          footer: "Cookies are kept in Paperback on this device and are not sent to manifold.jfa.dev.",
        },
        [
          LabelRow("comix-status", {
            title: "Status",
            value: status,
            style: this.source.hasSavedComixCookies() ? "success" : "warning",
          }),
          WebViewRow("comix-browser", {
            title: "Open Comix",
            request: {
              url: `${COMIX_ORIGIN}/`,
              method: "GET",
              headers: {
                Accept: "text/html,application/xhtml+xml",
              },
            },
            // SAFETY: value matches ComixSettingsForm at this call site
            onComplete: Application.Selector(this as ComixSettingsForm, "webViewCompleted"),
            // SAFETY: value matches ComixSettingsForm at this call site
            onCancel: Application.Selector(this as ComixSettingsForm, "webViewCancelled"),
          }),
        ],
      ),
    ];
  }

  readonly webViewCompleted = async (cookies: Cookie[]): Promise<void> => {
    await this.source.saveCloudflareBypassCookies(cookies);
    this.reloadForm();
  };

  readonly webViewCancelled = async (): Promise<void> => {
    // Paperback dismisses the WebView itself; there is no source state to change.
  };
}

export default new ComixSource();

export { mangaIdFromItem, hashIdFromMangaId } from "./parser.js";
