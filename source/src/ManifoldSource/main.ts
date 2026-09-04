import {
  AdvancedSearchForm,
  BasicRateLimiter,
  type BasicRateLimiterOptions,
  CloudflareError,
  CookieStorageInterceptor,
  Form,
  FlowSection,
  InputRow,
  LabelRow,
  PaperbackInterceptor,
  Section,
  type Chapter,
  type ChapterDetails,
  type ChapterProviding,
  type CloudflareBypassRequestProviding,
  type Cookie,
  type DiscoverSection,
  type Response as PaperbackResponse,
  type DiscoverSectionItem,
  type DiscoverSectionProviding,
  type Extension,
  type Form as PaperbackForm,
  type Metadata,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";
import type { CanonicalSearchResult } from "@manifold/canonical";
import {
  isFiniteNumber,
  isJsonObject,
  isString,
  requestHref,
  requestInitText,
  type JsonObject,
} from "@manifold/json";
import * as Effect from "effect/Effect";
import { createAniListSource, type CanonicalFetcher } from "@manifold/canonical/sources";
import { createMangaDexClient, type MangaDexFetcher } from "@manifold/mangadex";
import {
  ANILIST_SESSION_KEY,
  ANILIST_STATUS_KEY,
  ANILIST_VIEWER_ID_KEY,
  AniListUnauthorizedError,
  MANIFOLD_API_ORIGIN,
  MANIFOLD_API_STATUS_KEY,
  MANIFOLD_API_TOKEN_KEY,
  aniListRequest,
  configuredPersonalApi,
  errorMessage,
  fetchAniListLibrary,
  maybeDrainAniListOps,
  viewerQuery,
  type AniListViewer,
  type UpdateProbeFailureInput,
  type UpdateProbeReason,
} from "@manifold/paperback-runtime";
import {
  isMangaDexHostedChapter,
  providerFromInfo,
  toCanonicalSearchResult,
  toCanonicalSourceManga,
  toComixSourceManga,
  toMangaDexChapterDetails,
  toMangaDexChapters,
  toMangaDexSourceManga,
  buildMangaDexSourceManga,
} from "./mapper.js";
import {
  getDiscoverSections,
  getDiscoverSectionItems,
  type ManifoldDiscoverContext,
  type ManifoldLibraryEntry,
  type UpdateCard,
} from "./discover-sections.js";
import {
  clearanceCookiesOnly,
  comixChallenged,
  createComixFallback,
  isComixChapterId,
  resetComixCooldown,
  type ComixResolvedHid,
} from "./comix-fallback.js";
import info from "./pbconfig.js";

// Registry UUIDs are the only canonical manga ids; anything else that walks
// into getMangaDetails is a Comix hid(-slug) page id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredPersonalEntry {
  readonly id: string;
  readonly provider: string;
  readonly providerId: string;
  readonly title: string;
  readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  readonly chapterSource?: "auto" | "mangadex" | "comix";
}

const scheduledFetchResponse = (
  response: { readonly status: number; readonly headers: Record<string, string> },
  bodyBuffer: ArrayBuffer,
): Response => {
  const body = Application.arrayBufferToUTF8String(bodyBuffer);
  const headers = {
    get(name: string): string | null {
      const normalized = name.toLocaleLowerCase();
      const value = Object.entries(response.headers).find(
        ([key]) => key.toLocaleLowerCase() === normalized,
      )?.[1];
      return value ?? null;
    },
  };
  // SAFETY: scheduleRequest surface is a partial Response used by provider clients
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers,
    text: async () => body,
    // SAFETY: JSON.parse result is validated by provider response parsers
    json: async () => JSON.parse(body) as unknown,
  } as Response;
};

const COMIX_ORIGIN = "https://comix.to";
const COMIX_ORIGIN_HOST = "comix.to";

/** Device-wide chapter provider default. Registry per-title pins still win. */
const CHAPTER_SOURCE_DEFAULT_KEY = "manifold.chapter-source-default";
type ChapterSourceChoice = "auto" | "mangadex" | "comix";

const parseChapterSourceChoice = (value: string): ChapterSourceChoice | undefined => {
  if (value === "auto" || value === "mangadex" || value === "comix") {
    return value;
  }
  return undefined;
};

const readChapterSourceDefault = (): ChapterSourceChoice => {
  const raw = Application.getState(CHAPTER_SOURCE_DEFAULT_KEY);
  if (!isString(raw)) {
    return "auto";
  }
  return parseChapterSourceChoice(raw.trim().toLowerCase()) ?? "auto";
};

const chapterSourceForceOrUndefined = (
  value: ChapterSourceChoice,
): "mangadex" | "comix" | undefined => (value === "auto" ? undefined : value);

/** Bumped when the device chapter-source default changes so stale choice pins expire. */
const CHAPTER_SOURCE_EPOCH_KEY = "manifold.chapter-source-epoch";

const readChapterSourceEpoch = (): number => {
  const raw = Application.getState(CHAPTER_SOURCE_EPOCH_KEY);
  if (isFiniteNumber(raw)) {
    return raw;
  }
  if (isString(raw) && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const bumpChapterSourceEpoch = (): void => {
  Application.setState(String(readChapterSourceEpoch() + 1), CHAPTER_SOURCE_EPOCH_KEY);
};

/** Full chapter-list body cache. Choice cache only stores provider/hid; this
 * avoids re-hitting MangaDex / Comix WebView on every library refresh. */
const CHAPTER_LIST_CACHE_PREFIX = "manifold.chapters-body:v1:";
const CHAPTER_LIST_BODY_TTL_MS = 6 * 60 * 60 * 1000;
const CHAPTER_LIST_BODY_MAX_CHARS = 400_000;

type CachedChapterRow = {
  readonly chapterId: string;
  readonly langCode?: string;
  readonly chapNum: number;
  readonly title?: string;
  readonly volume?: number;
  readonly publishDate?: number;
  readonly additionalInfo?: Record<string, string>;
};

const chapterListCacheKey = (mangaId: string, provider: string, externalId: string): string =>
  `${CHAPTER_LIST_CACHE_PREFIX}${provider}:${externalId || mangaId}`;

const serializeChapterRows = (chapters: readonly Chapter[]): CachedChapterRow[] =>
  chapters.map((chapter) => ({
    chapterId: chapter.chapterId,
    ...(chapter.langCode !== undefined && { langCode: chapter.langCode }),
    chapNum: chapter.chapNum,
    ...(chapter.title !== undefined && { title: chapter.title }),
    ...(chapter.volume !== undefined && { volume: chapter.volume }),
    ...(chapter.publishDate instanceof Date &&
      !Number.isNaN(chapter.publishDate.getTime()) && {
        publishDate: chapter.publishDate.getTime(),
      }),
    ...(chapter.additionalInfo !== undefined && { additionalInfo: chapter.additionalInfo }),
  }));

const readChapterListBody = (
  cacheKey: string,
  sourceManga: SourceManga,
): Chapter[] | undefined => {
  const raw = Application.getState(cacheKey);
  if (!isString(raw) || raw.length === 0) {
    return undefined;
  }
  try {
    // SAFETY: I/O JSON.parse of the chapter-list body cache blob.
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    const cachedAt = parsed.t;
    const ttl = parsed.ttl;
    const rows = parsed.c;
    if (!isFiniteNumber(cachedAt) || !isFiniteNumber(ttl) || !Array.isArray(rows)) {
      return undefined;
    }
    if (Date.now() - cachedAt >= ttl) {
      return undefined;
    }
    const chapters: Chapter[] = [];
    for (const row of rows) {
      if (!isJsonObject(row) || !isString(row.chapterId) || !isFiniteNumber(row.chapNum)) {
        continue;
      }
      const additionalInfo = isJsonObject(row.additionalInfo)
        ? Object.fromEntries(
            Object.entries(row.additionalInfo).filter(
              (entry): entry is [string, string] => isString(entry[1]),
            ),
          )
        : undefined;
      chapters.push({
        chapterId: row.chapterId,
        sourceManga,
        chapNum: row.chapNum,
        ...(isString(row.langCode) && { langCode: row.langCode }),
        ...(isString(row.title) && { title: row.title }),
        ...(isFiniteNumber(row.volume) && { volume: row.volume }),
        ...(isFiniteNumber(row.publishDate) && { publishDate: new Date(row.publishDate) }),
        ...(additionalInfo !== undefined &&
          Object.keys(additionalInfo).length > 0 && { additionalInfo }),
      });
    }
    return chapters.length > 0 ? chapters : undefined;
  } catch {
    return undefined;
  }
};

const writeChapterListBody = (
  cacheKey: string,
  chapters: readonly Chapter[],
  ttlMs: number = CHAPTER_LIST_BODY_TTL_MS,
): void => {
  if (chapters.length === 0) {
    return;
  }
  try {
    const payload = JSON.stringify({
      t: Date.now(),
      ttl: ttlMs,
      c: serializeChapterRows(chapters),
    });
    // Skip oversized payloads — better a miss than blowing Application state.
    if (payload.length > CHAPTER_LIST_BODY_MAX_CHARS) {
      console.log(
        `[manifold] chapters body cache skip:${cacheKey}:chars=${payload.length}`,
      );
      return;
    }
    Application.setState(payload, cacheKey);
  } catch (error) {
    console.error(`[manifold] chapters body cache write failed:${errorMessage(error)}`);
  }
};


// Session/login cookies make comix.to's backend demand CSRF tokens on its
// API ("Missing token."); anonymous access needs only the clearance cookie.
// clearanceCookiesOnly (comix-fallback) also pins empty domains to comix.to.

// CookieStorageInterceptor only persists cookies with `expires` (stateManager
// filters `cookies.filter(x=>x.expires)`), so a session cf_clearance would be
// lost on restart and every My Updates · Comix open would rechallenge. Keep a
// redundant app-state copy so the clearance sticks across cold starts.
const CF_CLEARANCE_PERSIST_KEY = "manifold-cf-clearance-v1";
const COMIX_SESSION_ACTION_KEY = "manifold-comix-session-action-v1";
const persistCfClearance = (cookies: readonly Cookie[]): void => {
  const hit = clearanceCookiesOnly(cookies)[0];
  if (!hit) {return;}
  try {
    Application.setState(
      JSON.stringify({
        name: hit.name,
        value: hit.value,
        domain: hit.domain,
        path: hit.path ?? "/",
        expires: hit.expires instanceof Date ? hit.expires.toISOString() : hit.expires,
      }),
      CF_CLEARANCE_PERSIST_KEY,
    );
  } catch {
    // best-effort
  }
};
const restorePersistedCfClearance = (): Cookie | undefined => {
  const raw = Application.getState(CF_CLEARANCE_PERSIST_KEY);
  if (!isString(raw)) {return undefined;}
  try {
    // JSON can only round-trip the ISO string written by persistCfClearance.
    // SAFETY: I/O JSON.parse of the persisted cf_clearance cookie blob.
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed) || parsed.name !== "cf_clearance" || !isString(parsed.value)) {
      return undefined;
    }
    let expires: Date | undefined;
    if (isString(parsed.expires)) {
      expires = new Date(parsed.expires);
      if (Number.isNaN(expires.getTime())) {return undefined;}
    }
    return {
      name: "cf_clearance",
      value: parsed.value,
      domain: isString(parsed.domain) && parsed.domain.length > 0 ? parsed.domain : COMIX_ORIGIN_HOST,
      path: isString(parsed.path) && parsed.path.length > 0 ? parsed.path : "/",
      ...(expires && { expires }),
    };
  } catch {
    return undefined;
  }
};

// comix image CDNs sit behind their own Cloudflare WAF and reject requests
// lacking a browser UA / comix referer; Paperback's downloader sends neither.
const COMIX_IMAGE_HOST = /(?:^|\.)wowpic[^/]*\.store$|(?:^|\.)comix\.to$/;

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

class ManifoldComixInterceptor extends PaperbackInterceptor {
  constructor() {
    super("manifold-comix");
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const host = /^https?:\/\/([^/:?]+)/.exec(request.url)?.[1] ?? "";
    if (!COMIX_IMAGE_HOST.test(host)) {return request;}
    return {
      ...request,
      headers: {
        ...request.headers,
        referer: `${COMIX_ORIGIN}/`,
        "user-agent": await Application.getDefaultUserAgent(),
      },
    };
  }

  override async interceptResponse(
    request: Request,
    response: PaperbackResponse,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const encodedHeaders = Object.keys(response.headers ?? {}).filter((key) =>
      /^x-(scramble|enc)/i.test(key),
    );
    if (encodedHeaders.length > 0) {
      console.log(
        `[manifold] comix encoded image:${request.url.slice(0, 70)}:${encodedHeaders.join(",")}`,
      );
    }
    return data;
  }
}

// MangaDex cover CDN (uploads.mangadex.org) serves a placeholder for hotlinked
// images without a mangadex.org referer. Inkdex's MangaDexInterceptor adds
// `referer: https://mangadex.org/` to every request; mirror that here so the
// Popular New Titles carousel (and Latest Updates) shows covers like inkdex does.
// The admin site proxies covers via /mangadex-cover for the same reason; for
// Paperback we can satisfy the CDN check with a header (cheaper than a remote
// proxy and keeps coverUrl as the canonical uploads URL).
class ManifoldMangaDexInterceptor extends PaperbackInterceptor {
  constructor() {
    super("manifold-mangadex");
  }

  override async interceptRequest(request: Request): Promise<Request> {
    const host = /^https?:\/\/([^/:?]+)/.exec(request.url)?.[1] ?? "";
    const isMangaDex = host.endsWith("mangadex.org") || host.endsWith("mangadex.net");
    if (!isMangaDex) {return request;}
    return {
      ...request,
      headers: {
        ...request.headers,
        referer: "https://mangadex.org/",
      },
    };
  }

  override async interceptResponse(
    _request: Request,
    _response: PaperbackResponse,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    return data;
  }
}

const scheduledMangaDexFetcher: MangaDexFetcher = async (input, init) => {
  const headers: Record<string, string> = {};
  if (isJsonObject(init?.headers)) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (isString(value)) {headers[key] = value;}
    }
  }
  const [response, bodyBuffer] = await Application.scheduleRequest({
    url: requestHref(input),
    method: init?.method ?? "GET",
    headers,
  });
  return scheduledFetchResponse(response, bodyBuffer);
};

const scheduledAniListFetcher: CanonicalFetcher = async (input, init) => {
  const headers: Record<string, string> = {};
  if (isJsonObject(init?.headers)) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (isString(value)) {headers[key] = value;}
    }
  }
  const requestBody = requestInitText(init);
  const [response, bodyBuffer] = await Application.scheduleRequest({
    url: requestHref(input),
    method: init?.method ?? "GET",
    headers,
    ...(requestBody !== undefined && { body: requestBody }),
  });
  return scheduledFetchResponse(response, bodyBuffer);
};

// Per-title latest probes for the My Updates sections ride expensive paths
// (WebView captures for Comix, per-title chapter fetches for MangaDex), so
// results are cached per AniList entry: long TTL on success, short on
// failure so interrupted probes self-heal without hammering upstreams.
const DISCOVER_LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const DISCOVER_LATEST_FAILURE_TTL_MS = 15 * 60 * 1000;
// My Updates · MangaDex used to Promise.all the whole library before first
// paint (~4 feed req/s → minutes of empty UI). Cap fresh probes per open and
// serve stale cards past TTL so the board populates immediately.
const MANGADEX_UPDATES_PROBE_BUDGET = 40;
// Comix latest cards need one WebView title capture each; budget keeps the
// first Discover paint under ~30s even when the registry already has hids.
const COMIX_UPDATES_PROBE_BUDGET = 12;
// Soft-fail outcomes for admin. Buffered per Discover open and flushed once
// so a board walk is one POST instead of N. Best-effort: never block UI.
const UPDATE_FAILURE_REPORT_MAX = 100;

interface CachedCardState {
  readonly card: UpdateCard;
  readonly fresh: boolean;
}

const cardFromCachedPayload = (card: JsonObject): UpdateCard | undefined => {
  if (!isString(card.mangaId) || !isString(card.chapterId)) {return undefined;}
  return {
    source: card.source === "Comix" ? "Comix" : "MD",
    mangaId: card.mangaId,
    chapterId: card.chapterId,
    subtitle: isString(card.subtitle) ? card.subtitle : "",
    ...(isString(card.publishDate) && { publishDate: new Date(card.publishDate) }),
  };
};

const readCachedCardState = (cacheKey: string): CachedCardState | undefined => {
  const raw = Application.getState(cacheKey);
  if (!isString(raw)) {return undefined;}
  try {
    // SAFETY: I/O JSON.parse of a Discover latest-card cache blob.
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed) || !isFiniteNumber(parsed.t) || !isFiniteNumber(parsed.ttl) || !isJsonObject(parsed.card)) {
      return undefined;
    }
    const card = cardFromCachedPayload(parsed.card);
    if (!card) {return undefined;}
    return { card, fresh: Date.now() - parsed.t < parsed.ttl };
  } catch {
    return undefined;
  }
};

const readCachedCard = (cacheKey: string): UpdateCard | undefined => {
  const state = readCachedCardState(cacheKey);
  return state?.fresh ? state.card : undefined;
};

const comixBypassRequest = async (): Promise<Request> => ({
  // Match inkdex Comix: bare origin, UA only — Discover sometimes drops the
  // bypass banner when the resolution request is over-specified.
  url: COMIX_ORIGIN,
  method: "GET",
  headers: {
    "user-agent": await Application.getDefaultUserAgent(),
  },
});

const isComixHost = (url: string): boolean => {
  const host = /^https?:\/\/([^/:?]+)/.exec(url)?.[1] ?? "";
  return host === COMIX_ORIGIN_HOST || host.endsWith(`.${COMIX_ORIGIN_HOST}`);
};

const isMangaDexHost = (url: string): boolean => {
  const host = /^https?:\/\/([^/:?]+)/.exec(url)?.[1] ?? "";
  return host.endsWith("mangadex.org") || host.endsWith("mangadex.net");
};

// BasicRateLimiter throttles every request its interceptor sees, not just one
// host — a My Updates board walk fires ~60 probes at once, and MangaDex's WAF
// 403s bursts from a single IP (its API allows ~5 req/s). Scope one limiter
// per fragile upstream and let everything else pass through untouched.
class HostRateLimiter extends BasicRateLimiter {
  private readonly matches: (url: string) => boolean;
  constructor(
    id: string,
    options: BasicRateLimiterOptions,
    matches: (url: string) => boolean,
  ) {
    super(id, options);
    this.matches = matches;
  }
  override async interceptRequest(request: Request): Promise<Request> {
    if (!this.matches(request.url)) {return request;}
    return super.interceptRequest(request);
  }
}

export class ManifoldSourceImpl implements
  Extension,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  DiscoverSectionProviding,
  SearchResultsProviding,
  SettingsFormProviding {
  private readonly canonicalResults = new Map<string, CanonicalSearchResult>();
  private readonly cookieStorage = new SafeCookieStorage();
  // Cloudflare on comix.to is the stricter gate: 2 req/s.
  private readonly comixRateLimiter = new HostRateLimiter(
    "manifold-rate",
    { numberOfRequests: 2, bufferInterval: 1, ignoreImages: true },
    isComixHost,
  );
  // MangaDex API budget: stay under its 5 req/s per-IP limit.
  private readonly mangaDexRateLimiter = new HostRateLimiter(
    "manifold-mangadex-rate",
    { numberOfRequests: 4, bufferInterval: 1, ignoreImages: true },
    isMangaDexHost,
  );
  // The personal API fans out (each md resolve can trigger upstream
  // searches), so keep board walks from stampeding it concurrently.
  private readonly personalApiRateLimiter = new HostRateLimiter(
    "manifold-personal-rate",
    { numberOfRequests: 3, bufferInterval: 1, ignoreImages: true },
    (url) => url.startsWith(MANIFOLD_API_ORIGIN),
  );
  private readonly comixImages = new ManifoldComixInterceptor();
  private readonly mangaDexCovers = new ManifoldMangaDexInterceptor();
  private readonly mangaDex = createMangaDexClient({
    fetcher: scheduledMangaDexFetcher,
    languages: ["en"],
    limit: 100,
  });
  private readonly aniList = createAniListSource({
    fetcher: scheduledAniListFetcher,
  });
  private readonly comix = createComixFallback({
    cookies: () => this.cookieStorage.cookies,
    setCookies: (cookies) => {
      // WebView captures round-trip the full jar; keep clearance only so
      // login/session cookies never re-enter and force CSRF on later fetches.
      // Empty write-backs must not wipe a still-valid session (same rule as
      // saveCloudflareBypassCookies). Persist on every live update so mid-
      // capture recovery survives cold start.
      const filtered = clearanceCookiesOnly(cookies);
      if (filtered.length === 0) {return;}
      this.cookieStorage.cookies = filtered;
      persistCfClearance(filtered);
    },
  });

  async initialise(): Promise<void> {
    console.log("[manifold] initialise:start");
    // Restore clearance that CookieStorageInterceptor would have dropped as a
    // session cookie (no expires). Keeps the challenge from reappearing on
    // every cold start / every My Updates · Comix page.
    const persisted = restorePersistedCfClearance();
    if (persisted) {
      const current = this.cookieStorage.cookies;
      if (!current.some((cookie) => cookie.name === "cf_clearance")) {
        this.cookieStorage.cookies = [...current, persisted];
        console.log("[manifold] restored persisted cf_clearance");
      }
    }
    this.cookieStorage.registerInterceptor();
    this.comixImages.registerInterceptor();
    this.mangaDexCovers.registerInterceptor();
    // Comix tolerates very little concurrency before re-challenging; cap
    // request rate globally (images excluded so reading stays smooth).
    this.comixRateLimiter.registerInterceptor();
    // MangaDex and the personal API get their own budgets — see HostRateLimiter.
    this.mangaDexRateLimiter.registerInterceptor();
    this.personalApiRateLimiter.registerInterceptor();
    console.log("[manifold] initialise:ready");
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    // Paperback may still call the deprecated harvest path after a manga-entry
    // challenge. It must share the full recovery + cooldown reset of
    // cloudflareBypassCompleted — otherwise CF stays "challenged" for 45s and
    // chapter refresh keeps failing while Settings `force` appears to work.
    await this.applyComixBypassCookies(cookies, "save");
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    await this.applyComixBypassCookies(cookies, "complete");
  }

  /**
   * Apply cookies harvested after a Cloudflare challenge sheet closes.
   * Shared by deprecated `saveCloudflareBypassCookies` and
   * `cloudflareBypassCompleted` so manga-entry refresh cannot skip recovery.
   */
  private async applyComixBypassCookies(
    cookies: Cookie[],
    source: "save" | "complete",
  ): Promise<void> {
    const harvested = clearanceCookiesOnly(cookies);
    let resolved = harvested;

    if (harvested.length === 0) {
      // The app's bypass-harvest script can die with "Return statements are
      // only valid inside functions" (WKError Code=4) and deliver nothing.
      // The solved clearance still lives in the shared WebView cookie store —
      // read it back out through our own probe webview. Use a bare expression
      // (no leading `return`) — some WebView runtimes eval at top level where
      // `return` is a SyntaxError, which is exactly the WKError we see in
      // logs after every Comix challenge.
      try {
        const execution = await Application.executeInWebView({
          source: {
            html: "<!doctype html><title>comix-bypass-recovery</title>",
            baseUrl: `${COMIX_ORIGIN}/`,
            loadCSS: false,
            loadImages: false,
            userAgent: await Application.getDefaultUserAgent(),
          },
          inject: "document.title",
          storage: { cookies: [...this.cookieStorage.cookies] },
        });
        const recovered = clearanceCookiesOnly(execution.storage.cookies);
        if (recovered.length > 0) {
          console.log(
            `[manifold] comix bypass recovery:${recovered.length} cookie(s) from webview store`,
          );
          resolved = recovered;
        }
      } catch (error) {
        console.error(
          `[manifold] comix bypass recovery failed:${errorMessage(error)}`,
        );
      }
    }

    // If harvest + recovery both empty, keep whatever clearance we already had
    // instead of writing [] and forcing another challenge on the next Discover.
    if (resolved.length === 0) {
      const existing = clearanceCookiesOnly(this.cookieStorage.cookies);
      if (existing.length > 0) {
        console.log(
          `[manifold] comix bypass empty harvest; kept ${existing.length} existing clearance`,
        );
        resolved = existing;
      }
    }

    this.cookieStorage.cookies = resolved;
    if (resolved.length > 0) {persistCfClearance(resolved);}
    // Always clear cooldown after a completed challenge sheet — even when the
    // harvest was empty. Leaving sessionBroken/cooldown set is what made
    // manga-entry CF refresh look broken while Settings `force` worked
    // (force resets cooldown before throwing a fresh CloudflareError).
    resetComixCooldown();
    this.noteComixSessionAction(
      resolved.length > 0
        ? `bypass ${source}:${resolved.length}`
        : `bypass ${source}: empty`,
    );
    console.log(
      `[manifold] comix bypass ${source}:${this.cookieStorage.cookies.length}`,
    );
  }

  private comixClearanceCookie(): Cookie | undefined {
    const now = Date.now();
    // Jar is clearance-only + domain-normalized on every write.
    return clearanceCookiesOnly(this.cookieStorage.cookies).find((cookie) => {
      if (cookie.expires instanceof Date && !Number.isNaN(cookie.expires.getTime())) {
        return cookie.expires.getTime() > now;
      }
      return true;
    });
  }

  hasComixBrowserSession(): boolean {
    // Only a live cf_clearance counts. Any other comix.to cookie (or an
    // expired clearance) used to skip the proactive Discover challenge and
    // leave My Updates · Comix empty with no banner.
    return this.comixClearanceCookie() !== undefined;
  }

  comixSessionStatusLabel(): string {
    const clearance = this.comixClearanceCookie();
    const lastAction =
      // SAFETY: Paperback secure/state store returns string | undefined)?.trim() || und for this key
      (Application.getState(COMIX_SESSION_ACTION_KEY) as string | undefined)?.trim() || undefined;
    if (!clearance) {
      return lastAction
        ? `No cf_clearance · ${lastAction}`
        : "No cf_clearance — use a button below.";
    }
    const preview = `${clearance.value.slice(0, 8)}…`;
    const expires =
      clearance.expires instanceof Date && !Number.isNaN(clearance.expires.getTime())
        ? ` · expires ${clearance.expires.toISOString().slice(0, 16)}Z`
        : " · session cookie";
    return lastAction
      ? `cf_clearance ${preview}${expires} · ${lastAction}`
      : `cf_clearance ${preview}${expires}`;
  }

  private noteComixSessionAction(message: string): void {
    try {
      Application.setState(message, COMIX_SESSION_ACTION_KEY);
    } catch {
      // best-effort
    }
  }

  clearComixSession(): void {
    this.cookieStorage.cookies = [];
    try {
      Application.setState("", CF_CLEARANCE_PERSIST_KEY);
    } catch {
      // best-effort
    }
    resetComixCooldown();
    this.noteComixSessionAction("cleared");
    console.log("[manifold] comix session cleared");
  }

  /**
   * Pull cf_clearance from Paperback's shared WebView cookie store without
   * opening a challenge. Useful after a silent bypass harvest or to test
   * whether the store already holds a usable clearance.
   */
  async adoptComixClearanceFromStore(): Promise<boolean> {
    try {
      const execution = await Application.executeInWebView({
        source: {
          html: "<!doctype html><title>comix-clearance-adopt</title>",
          baseUrl: `${COMIX_ORIGIN}/`,
          loadCSS: false,
          loadImages: false,
          userAgent: await Application.getDefaultUserAgent(),
        },
        inject: "document.title",
        storage: { cookies: [...this.cookieStorage.cookies] },
      });
      const recovered = clearanceCookiesOnly(execution.storage.cookies);
      if (recovered.length === 0) {
        this.noteComixSessionAction("adopt: none in WebView store");
        console.log("[manifold] comix adopt: no cf_clearance in webview store");
        return false;
      }
      this.cookieStorage.cookies = recovered;
      persistCfClearance(recovered);
      resetComixCooldown();
      this.noteComixSessionAction(`adopted ${recovered.length}`);
      console.log(`[manifold] comix adopt:${recovered.length} clearance cookie(s)`);
      return true;
    } catch (error) {
      this.noteComixSessionAction("adopt failed");
      console.error(`[manifold] comix adopt failed:${errorMessage(error)}`);
      return false;
    }
  }

  async forceComixCloudflareBypass(): Promise<never> {
    // Do NOT clear an existing cf_clearance here. Wiping before the app sheet
    // opens caused a solve → Discover probe → clear → challenge loop.
    resetComixCooldown();
    this.noteComixSessionAction("force bypass thrown");
    throw new CloudflareError(
      await comixBypassRequest(),
      "Comix Cloudflare bypass — complete the browser challenge",
    );
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    maybeDrainAniListOps();
    const title = query.title.trim();
    console.log(`[manifold] search:${title || "<empty>"}`);
    if (!title) {return { items: [] };}

    let results;
    try {
      results = await Effect.runPromise(this.aniList.search(title, { limit: 25 }));
    } catch (error) {
      console.error(`[manifold] AniList search failed: ${errorMessage(error)}`);
      throw error;
    }

    // Registry identity: every hit is minted/resolved to a provider-neutral
    // UUID which becomes the Paperback manga id for the whole pipeline.
    let mapped = results;
    try {
      const entries = await configuredPersonalApi().resolveEntries(
        results.map((result) => ({
          provider: "anilist" as const,
          providerId: result.providerId,
          title: result.title,
        })),
      );
      const uuidByAnilist = new Map(
        entries.flatMap((entry) => {
          const link = entry.providers.find((provider) => provider.provider === "anilist");
          return link ? [[link.externalId, entry.id] as const] : [];
        }),
      );
      mapped = results.map((result) => {
        const uuid = uuidByAnilist.get(result.providerId);
        return uuid ? { ...result, id: uuid } : result;
      });
    } catch (error) {
      console.error(`[manifold] registry resolve failed: ${errorMessage(error)}`);
    }

    for (const entry of mapped) {this.canonicalResults.set(entry.id, entry);}
    return {
      items: mapped.map(toCanonicalSearchResult),
    };
  }

  async getAdvancedSearchForm(
    _query: SearchQuery<Metadata>,
  ): Promise<AdvancedSearchForm> {
    return new ManifoldAdvancedSearchForm();
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    maybeDrainAniListOps();
    // Feed/discover cards carry raw MangaDex ids; they land in the registry
    // as mangadex-first rows (the manual-bind case).
    if (mangaId.startsWith("mangadex:")) {
      return this.getMangaDetailsFromMangaDex(mangaId.slice("mangadex:".length));
    }
    // My Updates Comix winners carry `<hid>-<slug>` manga ids; resolve the
    // title page's server-rendered initial-data instead of the registry.
    if (!UUID_RE.test(mangaId)) {
      return this.comix.detailsByHid(mangaId);
    }

    const personalApi = configuredPersonalApi();
    let entry = this.canonicalResults.get(mangaId);
    if (!entry) {
      // Rehydrate from the registry, enriching with AniList metadata when an
      // anilist link exists (covers, descriptions).
      const stored = await personalApi.getEntry(mangaId);
      if (!stored) {throw new Error(`Registry entry not found: ${mangaId}`);}
      entry = await this.enrichFromStored(stored);
      this.canonicalResults.set(entry.id, entry);
    }

    let mangaDexId: string | undefined;
    try {
      const resolution = await personalApi.resolveMangaDex(entry);
      if (resolution.status === "matched" && resolution.externalId) {
        mangaDexId = resolution.externalId;
        console.log(
          `[manifold] MangaDex match:${entry.title}:${resolution.method ?? "unknown"}` +
            (resolution.score === undefined ? "" : `:${resolution.score.toFixed(3)}`),
        );
      }
    } catch (error) {
      console.error(`[manifold] MangaDex resolve failed: ${errorMessage(error)}`);
    }

    if (!mangaDexId) {
      // No verified MangaDex entry — Comix is the fallback reading provider
      // for exactly these titles. The registry row keeps its AniList link
      // and gains a comix link; reads flow with comix provenance.
      const titles = [entry.title, ...entry.aliases];
      const resolved = await this.comix.resolveHid(titles);
      if (!resolved.hid) {
        throw new Error(`No MangaDex or Comix source found for ${entry.title}`);
      }
      await personalApi.linkProvider(mangaId, {
        provider: "comix",
        externalId: resolved.hid,
        title: entry.title,
      });
      console.log(`[manifold] Comix fallback match:${entry.title}:${resolved.hid}`);
      return toComixSourceManga(toCanonicalSourceManga(entry), resolved.hid);
    }

    const manga = await Effect.runPromise(this.mangaDex.getManga(mangaDexId));
    const linked = await personalApi
      .getEntry(mangaId)
      .then((stored) => stored?.providers.find((provider) => provider.provider === "mangadex"))
      .catch(() => undefined);
    if (!linked || linked.externalId !== manga.id) {
      await personalApi.linkProvider(mangaId, {
        provider: "mangadex",
        externalId: manga.id,
        title: manga.title,
      });
    }
    return toMangaDexSourceManga(entry, manga);
  }

  private async enrichFromStored(
    stored: StoredPersonalEntry,
  ): Promise<CanonicalSearchResult> {
    const minimal: CanonicalSearchResult = {
      id: stored.id,
      provider: "anilist",
      providerId: stored.providerId,
      title: stored.title,
      aliases: [],
      score: 0,
    };
    const aniLink = stored.providers.find((provider) => provider.provider === "anilist");
    if (!aniLink) {return minimal;}
    try {
      const canonical = await Effect.runPromise(this.aniList.getById(aniLink.externalId));
      return canonical ? { ...canonical, id: stored.id, score: 0 } : minimal;
    } catch (error) {
      console.error(`[manifold] AniList enrichment failed: ${errorMessage(error)}`);
      return minimal;
    }
  }

  /** Mangadex-first registry rows for feed cards with no canonical match yet. */
  private async getMangaDetailsFromMangaDex(mangaDexId: string): Promise<SourceManga> {
    const personalApi = configuredPersonalApi();
    const manga = await Effect.runPromise(this.mangaDex.getManga(mangaDexId));
    const linked = await personalApi.entryByMangaDex(mangaDexId);
    if (linked?.id) {
      console.log(`[manifold] MangaDex reverse link:${manga.title}:${linked.id}`);
      return buildMangaDexSourceManga(manga, linked.id);
    }
    // resolveEntry mints the UUID row and stamps its first provider link.
    const minted = await personalApi.resolveEntry({
      provider: "mangadex",
      providerId: mangaDexId,
      title: manga.title,
    });
    console.log(`[manifold] MangaDex local entry:${manga.title}:${minted.id}`);
    return buildMangaDexSourceManga(manga, minted.id);
  }

  // Shared AniList fetch + registry UUID minting for discover's per-title
  // probes. Split the library slice so the two My Updates boards can carry
  // different filters without duplicating the resolve logic.
  private async fetchAnilistLibraryFiltered(
    allowed: ReadonlySet<string>,
  ): Promise<ManifoldLibraryEntry[]> {
    // SAFETY: Paperback secure/state store returns string | undefined; const viewerId = Application for this key
    const token = Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined;
    // SAFETY: Paperback secure/state store returns string | number | undefined; if (!token || !viewerId) {re for this key
    const viewerId = Application.getState(ANILIST_VIEWER_ID_KEY) as string | number | undefined;
    if (!token || !viewerId) {return [];}
    try {
      const list = await fetchAniListLibrary(token, Number(viewerId));
      const filtered = list.filter((e) => allowed.has(e.status));
      if (filtered.length === 0) {return [];}
      let uuids = new Map<string, string>();
      try {
        const resolved = await configuredPersonalApi().resolveEntries(
          filtered.map((e) => ({
            provider: "anilist" as const,
            providerId: e.anilistId,
            title: e.title,
          })),
        );
        uuids = new Map(
          resolved.flatMap((entry) => {
            const link = entry.providers.find((provider) => provider.provider === "anilist");
            return link ? [[link.externalId, entry.id] as const] : [];
          }),
        );
      } catch (error) {
        console.error(`[manifold] registry resolve failed: ${errorMessage(error)}`);
      }
      return filtered.map((e) => {
        const uuid = uuids.get(e.anilistId);
        // SAFETY: value is readonly string[] at this site
        return {
          ...(uuid !== undefined ? { id: uuid } : { id: `anilist:${e.anilistId}` }),
          title: e.title,
          aliases: [] as readonly string[],
          // SAFETY: value matches anilistId: e.anilistId at this call site
          anilistId: e.anilistId,
          // SAFETY: value matches rl, }; }); at this call site
          coverUrl: (e as { coverUrl?: string }).coverUrl,
        };
      });
    } catch {
      return [];
    }
  }

  private syncContext(options?: {
    readonly mdProbeBudget?: { remaining: number };
    readonly comixProbeBudget?: { remaining: number };
  }): ManifoldDiscoverContext {
    // Comix stays reading-only (expensive WebView capture), MangaDex widens to
    // reading + planning (plan_to_read) + on_hold (PAUSED). Status vocabulary
    // is the registry form (reading/on_hold/plan_to_read), matching
    // normalizeAniListStatus's output.
    const COMIX_STATUSES = new Set<string>(["reading"]);
    const MANGADEX_STATUSES = new Set<string>(["reading", "plan_to_read", "on_hold"]);
    const mdBudget = options?.mdProbeBudget;
    const comixBudget = options?.comixProbeBudget;
    return {
      listManga: (opts) => Effect.runPromise(this.mangaDex.listManga(opts)),
      latestChapters: (opts) => Effect.runPromise(this.mangaDex.latestChapters(opts)),
      getAnilistLibrary: () => this.fetchAnilistLibraryFiltered(COMIX_STATUSES),
      getAnilistLibraryForMangadex: () =>
        this.fetchAnilistLibraryFiltered(MANGADEX_STATUSES),
      noteUpdateFailure: (entry, source, reason, detail) => {
        this.noteUpdateFailure(entry, source, reason, detail);
      },
      mangadexLatest: async (entry) => {
        const cacheKey = `md-hosted-latest:${entry.id}`;
        const cached = readCachedCardState(cacheKey);
        if (cached?.fresh) {return cached.card;}
        // Budget is decremented synchronously before the await so Promise.all
        // workers cannot stampede past MANGADEX_UPDATES_PROBE_BUDGET.
        if (mdBudget) {
          if (mdBudget.remaining <= 0) {return cached?.card;}
          mdBudget.remaining -= 1;
        }
        try {
          return await this.cachedLatestCard(
            cacheKey,
            "md",
            () => this.probeMangaDexLatest(entry),
            {
              staleFallback: cached?.card,
              onSoftError: (message) => this.noteUpdateFailure(entry, "MD", "error", message),
            },
          );
        } catch (error) {
          this.noteUpdateFailure(entry, "MD", "error", errorMessage(error));
          throw error;
        }
      },
      comixLatest: async (entry) => {
        const cacheKey = `comix-latest:${entry.id}`;
        const cached = readCachedCardState(cacheKey);
        if (cached?.fresh) {return cached.card;}
        if (comixBudget) {
          if (comixBudget.remaining <= 0) {return cached?.card;}
          comixBudget.remaining -= 1;
        }
        try {
          return await this.cachedLatestCard(
            cacheKey,
            "comix",
            () => this.probeComixLatest(entry),
            {
              staleFallback: cached?.card,
              onSoftError: (message) => this.noteUpdateFailure(entry, "Comix", "error", message),
            },
          );
        } catch (error) {
          if (!(error instanceof CloudflareError)) {
            this.noteUpdateFailure(entry, "Comix", "error", errorMessage(error));
            throw error;
          }
          console.error(
            `[manifold] comix latest CF:${entry.title}:${error.message}`,
          );
          // One silent recovery attempt from the shared WebView store before
          // soft-failing this card (Discover rarely shows the bypass banner).
          const adopted = await this.adoptComixClearanceFromStore();
          if (adopted) {
            try {
              return await this.probeComixLatest(entry);
            } catch (retryError) {
              if (!(retryError instanceof CloudflareError)) {
                this.noteUpdateFailure(entry, "Comix", "error", errorMessage(retryError));
                throw retryError;
              }
              console.error(
                `[manifold] comix latest CF after adopt:${entry.title}`,
              );
              this.noteUpdateFailure(entry, "Comix", "cloudflare", retryError.message);
            }
          } else {
            this.noteUpdateFailure(entry, "Comix", "cloudflare", error.message);
          }
          return cached?.card;
        }
      },
    };
  }

  private async cachedLatestCard(
    cacheKey: string,
    label: string,
    probe: () => Promise<UpdateCard | undefined>,
    options?: {
      readonly staleFallback?: UpdateCard;
      readonly onSoftError?: (message: string) => void;
    },
  ): Promise<UpdateCard | undefined> {
    const cached = readCachedCard(cacheKey);
    if (cached) {return cached;}
    // The globally-sorted MangaDex board re-probes the whole library for every
    // page request, so concurrent walks race before any cache entry exists.
    // Share one in-flight promise per key instead of stampeding the upstreams.
    const pending = this.pendingLatest.get(cacheKey);
    if (pending) {
      return (await pending) ?? options?.staleFallback;
    }
    const run = this.probeAndCacheLatest(cacheKey, label, probe, options);
    this.pendingLatest.set(cacheKey, run);
    try {
      return await run;
    } finally {
      this.pendingLatest.delete(cacheKey);
    }
  }

  private async probeAndCacheLatest(
    cacheKey: string,
    label: string,
    probe: () => Promise<UpdateCard | undefined>,
    options?: {
      readonly staleFallback?: UpdateCard;
      readonly onSoftError?: (message: string) => void;
    },
  ): Promise<UpdateCard | undefined> {
    const writeFailure = (): void => {
      Application.setState(
        JSON.stringify({ t: Date.now(), ttl: DISCOVER_LATEST_FAILURE_TTL_MS }),
        cacheKey,
      );
    };
    try {
      const card = await probe();
      if (!card) {
        // Keep a still-usable stale card instead of wiping it with a miss TTL.
        if (options?.staleFallback) {return options.staleFallback;}
        writeFailure();
        return undefined;
      }
      Application.setState(
        JSON.stringify({
          t: Date.now(),
          ttl: DISCOVER_LATEST_TTL_MS,
          card: {
            source: card.source,
            mangaId: card.mangaId,
            chapterId: card.chapterId,
            subtitle: card.subtitle,
            ...(card.publishDate && { publishDate: card.publishDate.toISOString() }),
          },
        }),
        cacheKey,
      );
      return card;
    } catch (error) {
      // Cloudflare challenges are a user-action gate, not a transient failure.
      // Surface the challenge instead of caching a failure and hiding the banner.
      if (error instanceof CloudflareError) {throw error;}
      console.error(`[manifold] ${label} latest failed:${errorMessage(error)}`);
      options?.onSoftError?.(errorMessage(error));
      if (options?.staleFallback) {return options.staleFallback;}
      writeFailure();
      return undefined;
    }
  }

  // In-flight latest probes keyed by cacheKey — see cachedLatestCard.
  private readonly pendingLatest = new Map<string, Promise<UpdateCard | undefined>>();
  // Buffered Discover probe failures for the current open; flushed after the page returns.
  private pendingUpdateFailures: UpdateProbeFailureInput[] = [];

  private noteUpdateFailure(
    entry: ManifoldLibraryEntry,
    source: "MD" | "Comix",
    reason: UpdateProbeReason,
    detail?: string,
  ): void {
    if (this.pendingUpdateFailures.length >= UPDATE_FAILURE_REPORT_MAX) {return;}
    const trimmedDetail = detail?.trim();
    this.pendingUpdateFailures.push({
      title: entry.title,
      source,
      reason,
      entryId: entry.id.length > 0 ? entry.id : undefined,
      detail:
        trimmedDetail && trimmedDetail.length > 0
          ? trimmedDetail.slice(0, 1000)
          : undefined,
    });
  }

  private flushUpdateFailures(): void {
    const failures = this.pendingUpdateFailures;
    this.pendingUpdateFailures = [];
    if (failures.length === 0) {return;}
    // Fire-and-forget: Discover must not wait on admin telemetry.
    void configuredPersonalApi()
      .reportUpdateFailures(failures)
      .then((result) => {
        console.log(`[manifold] update-failures reported:${result.recorded}`);
      })
      .catch((cause) => {
        console.error(`[manifold] update-failures report failed:${errorMessage(cause)}`);
      });
  }

  private async probeMangaDexLatest(
    entry: ManifoldLibraryEntry,
  ): Promise<UpdateCard | undefined> {
    // resolveMangaDex prefers its cached provider link and never calls
    // AniList, so build the minimal entry directly — no getCanonical round
    // trip (AniList 403s Worker egress and would fail the whole probe).
    const resolution = await configuredPersonalApi().resolveMangaDex({
      id: entry.id,
      provider: "anilist",
      providerId: entry.anilistId ?? entry.id,
      title: entry.title,
      aliases: [...entry.aliases],
    });
    if (resolution.status !== "matched" || !resolution.externalId) {
      console.log(`[manifold] md latest unresolved:${entry.title}:${resolution.status}`);
      this.noteUpdateFailure(
        entry,
        "MD",
        "md_unresolved",
        `${resolution.status}${resolution.method ? `:${resolution.method}` : ""}`,
      );
      return undefined;
    }
    // Scan one newest-first page rather than paginating the full chapter list.
    // Licensed releases can occupy the first several slots as external links,
    // so fetch enough entries to find the newest MangaDex-hosted chapter.
    const page = await Effect.runPromise(
      this.mangaDex.feedChapters(resolution.externalId, { limit: 100 }),
    );
    const newest = page.items.find(isMangaDexHostedChapter);
    if (!newest) {
      this.noteUpdateFailure(
        entry,
        "MD",
        "md_no_hosted_chapter",
        `feed=${page.items.length}`,
      );
      return undefined;
    }
    return {
      source: "MD",
      mangaId: entry.id,
      chapterId: newest.id,
      subtitle: `Ch. ${newest.chapterNumber ?? 0} · MangaDex`,
      ...(!(newest.publishedAt === undefined) && { publishDate: new Date(newest.publishedAt) }),
    };
  }

  private async probeComixLatest(
    entry: ManifoldLibraryEntry,
  ): Promise<UpdateCard | undefined> {
    const titles = [entry.title, ...entry.aliases];
    // Latest-card probes only need a decent match; each search page is a
    // WebView capture, so keep the sweep to 3 titles x 1 page instead of the
    // chapter-list default (6 x 2).
    const resolveHid = (): Promise<ComixResolvedHid> =>
      this.comix.resolveHid(titles, { maxTitles: 3, pages: 1 });
    // The hid for a title is stable — cache it (7d) so each 6h card refresh
    // costs one title-page capture instead of a full alias search sweep.
    const hidKey = `comix-hid:${entry.id}`;
    const HID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const readHidCache = (): ComixResolvedHid | undefined => {
      const raw = Application.getState(hidKey);
      if (!isString(raw)) {return undefined;}
      try {
        // SAFETY: I/O JSON.parse of the per-title Comix hid cache blob.
        const parsed: unknown = JSON.parse(raw);
        if (
          !isJsonObject(parsed) ||
          !isFiniteNumber(parsed.t) ||
          Date.now() - parsed.t >= HID_TTL_MS ||
          !isString(parsed.hid) ||
          parsed.hid.length === 0
        ) {
          return undefined;
        }
        return { hid: parsed.hid, ...(isString(parsed.slug) && { slug: parsed.slug }) };
      } catch {
        return undefined;
      }
    };
    const writeHidCache = (resolved: ComixResolvedHid): void => {
      if (!resolved.hid) {return;}
      Application.setState(
        JSON.stringify({ t: Date.now(), hid: resolved.hid, ...(resolved.slug && { slug: resolved.slug }) }),
        hidKey,
      );
    };
    // Persist a freshly swept hid into the registry so it survives
    // reinstalls and seeds other devices. Best-effort: a registry outage
    // must never fail the probe.
    const linkHidToRegistry = (hidValue: string): void => {
      configuredPersonalApi()
        .linkProvider(entry.id, { provider: "comix", externalId: hidValue, title: entry.title })
        .then(() => console.log(`[manifold] comix hid linked:${entry.title}:${hidValue}`))
        .catch((cause) =>
          console.error(`[manifold] comix hid link failed:${entry.title}:${errorMessage(cause)}`),
        );
    };

    const cached = readHidCache();
    let hid = cached?.hid;
    let slug = cached?.slug;
    const fromCache = hid !== undefined && hid.length > 0;
    if (!hid) {
      // Device cache miss — the registry may already hold a comix link from
      // a previous sweep or the search fallback; skip the WebView sweep.
      const stored = await configuredPersonalApi()
        .getEntry(entry.id)
        .catch(() => undefined);
      const link = stored?.providers.find((provider) => provider.provider === "comix");
      if (link?.externalId) {
        console.log(`[manifold] comix hid from registry:${entry.title}:${link.externalId}`);
        hid = link.externalId;
      }
    }
    if (!hid) {
      const resolved = await resolveHid();
      if (!resolved.hid) {
        console.log(`[manifold] comix latest miss:${entry.title}`);
        this.noteUpdateFailure(entry, "Comix", "comix_hid_miss");
        return undefined;
      }
      hid = resolved.hid;
      slug = resolved.slug;
      writeHidCache(resolved);
      linkHidToRegistry(hid);
    }
    let latest = await this.comix.latestChapterByHid(hid);
    if (!latest && fromCache) {
      // Cached hid went stale (retitled/removed) — invalidate and sweep once.
      console.log(`[manifold] comix hid stale:${entry.title}:${hid}`);
      Application.setState("", hidKey);
      const refreshed = await resolveHid();
      if (!refreshed.hid) {
        this.noteUpdateFailure(entry, "Comix", "comix_hid_miss", "stale-hid-refresh");
        return undefined;
      }
      hid = refreshed.hid;
      slug = refreshed.slug;
      writeHidCache(refreshed);
      linkHidToRegistry(hid);
      latest = await this.comix.latestChapterByHid(hid);
    }
    if (!latest) {
      console.log(`[manifold] comix latest empty:${entry.title}:${hid}`);
      this.noteUpdateFailure(entry, "Comix", "comix_empty", `hid=${hid}`);
      return undefined;
    }
    return {
      source: "Comix",
      mangaId: slug ? `${hid}-${slug}` : hid,
      chapterId: `comix:${latest.id}`,
      subtitle: `Ch. ${latest.chapNum} · Comix`,
      ...(latest.publishedAt && { publishDate: latest.publishedAt }),
    };
  }
  getDiscoverSections(): Promise<DiscoverSection[]> {
    return getDiscoverSections();
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    // Only force the bypass sheet when we have no clearance at all. Mid-board
    // challenges soft-fail per card (Discover often omits the banner). Use
    // Settings `force` / `adopt` when the board stays empty after a solve.
    // Before throwing, try once to pull clearance from the shared WK store —
    // the app harvest often dies with WKError right after a successful solve
    // and leaves cf_clearance only in that store, so the next open would
    // otherwise re-prompt forever even though the challenge already stuck.
    if (section.id === "my-updates-comix") {
      // Prefer a silent adopt from the shared WK store before throwing the
      // banner — the app harvest often dies with WKError right after a solve
      // and leaves cf_clearance only in that store, so the next open would
      // otherwise re-prompt forever even though the challenge already stuck.
      if (!this.hasComixBrowserSession()) {
        const adopted = await this.adoptComixClearanceFromStore();
        console.log(
          `[manifold] comix updates: adopt before board=${adopted} session=${this.hasComixBrowserSession()}`,
        );
      }
      if (!this.hasComixBrowserSession()) {
        console.log("[manifold] comix updates: no cf_clearance — requesting bypass");
        throw new CloudflareError(
          await comixBypassRequest(),
          "Comix Cloudflare check required — complete the browser challenge",
        );
      }
      console.log(
        `[manifold] comix updates: session=${this.hasComixBrowserSession() ? "ok" : "missing"} challenged=${comixChallenged()}`,
      );
    }
    const context =
      section.id === "my-updates-mangadex"
        ? this.syncContext({
            mdProbeBudget: { remaining: MANGADEX_UPDATES_PROBE_BUDGET },
          })
        : section.id === "my-updates-comix"
          ? this.syncContext({
              comixProbeBudget: { remaining: COMIX_UPDATES_PROBE_BUDGET },
            })
          : this.syncContext();
    try {
      const page = await getDiscoverSectionItems(section, metadata, context);
      this.flushUpdateFailures();
      return page;
    } catch (error) {
      this.flushUpdateFailures();
      // Keep cf_clearance on CloudflareError. Clearing here (2.0.20–2.0.24)
      // wiped a freshly solved session as soon as Discover re-probed Comix,
      // forcing an endless bypass loop (logs: "comix session cleared after
      // CloudflareError"). Only the explicit Settings `clear` command may wipe.
      if (error instanceof CloudflareError && section.id === "my-updates-comix") {
        console.log("[manifold] comix CloudflareError surfaced (session kept)");
      }
      throw error;
    }
  }

  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    maybeDrainAniListOps();
    const provider = providerFromInfo(sourceManga);
    const choiceKey = `comix-source-choice:v2:${sourceManga.mangaId}`;
    const CHOICE_TTL_MS = 6 * 60 * 60 * 1000;
    const MANGADEX_RECHECK_TTL_MS = 6 * 60 * 60 * 1000;
    const FAILED_RETRY_TTL_MS = 10 * 60 * 1000;
    // Below this many MangaDex chapters we still compare against Comix
    // (the "MD lists 1 chapter, Comix has 214" edge); at or above it,
    // MangaDex is trusted without touching comix.to.
    const MANGADEX_TRUST_THRESHOLD = 5;
    const chapterSourceEpoch = readChapterSourceEpoch();
    const cachedChoice = (():
      | { p: "comix" | "mangadex"; t: number; ttl: number; n: number; h?: string; e: number }
      | undefined => {
      const raw = Application.getState(choiceKey);
      if (!isString(raw)) {return undefined;}
      try {
        // SAFETY: I/O JSON.parse of the chapter-source choice cache blob.
        const parsed: unknown = JSON.parse(raw);
        if (
          isJsonObject(parsed) &&
          (parsed.p === "comix" || parsed.p === "mangadex") &&
          isFiniteNumber(parsed.t)
        ) {
          // Entries written before tiered TTLs (<=v1.0.30) carry no ttl field;
          // treat them as expired so stuck titles re-compare on first open.
          if (!isFiniteNumber(parsed.ttl)) {return undefined;}
          return {
            p: parsed.p,
            t: parsed.t,
            ttl: parsed.ttl,
            n: isFiniteNumber(parsed.n) ? parsed.n : 0,
            h: isString(parsed.h) ? parsed.h : undefined,
            // Missing e (pre-device-default builds) is epoch 0.
            e: isFiniteNumber(parsed.e) ? parsed.e : 0,
          };
        }
      } catch {
        return undefined;
      }
      return undefined;
    })();
    // Empty or tiny MangaDex pins are the "comix capture succeeded in WebView
    // but fetchChaptersByHid returned []" failure mode — never treat as fresh.
    const emptyOrTinyMangadexPin =
      cachedChoice?.p === "mangadex" && (cachedChoice.n ?? 0) < 10;
    const missingComixHid =
      cachedChoice?.p === "comix" && !cachedChoice.h;
    const choiceFresh =
      cachedChoice !== undefined &&
      cachedChoice.e === chapterSourceEpoch &&
      Date.now() - cachedChoice.t < cachedChoice.ttl &&
      !emptyOrTinyMangadexPin &&
      !missingComixHid;

    const finalize = (chapters: Chapter[]): Chapter[] =>
      sinceDate
        ? chapters.filter((chapter) => !chapter.publishDate || chapter.publishDate >= sinceDate)
        : chapters;

    // Discover Comix cards and detailsByHid use non-UUID manga ids (hid or
    // hid-slug). Go straight to Comix — never compare against MangaDex.
    const comixPageId = !UUID_RE.test(sourceManga.mangaId)
      ? (sourceManga.mangaId.split("-")[0] ?? sourceManga.mangaId)
      : provider?.provider === "comix"
        ? provider.externalId
        : undefined;
    if (comixPageId) {
      console.log(`[manifold] chapters source:${sourceManga.mangaId}:comix-direct:${comixPageId}`);
      const bodyKey = chapterListCacheKey(sourceManga.mangaId, "comix", comixPageId);
      const cachedBody = readChapterListBody(bodyKey, sourceManga);
      if (cachedBody) {
        console.log(
          `[manifold] chapters body cache hit:${sourceManga.mangaId}:comix-direct:${cachedBody.length}`,
        );
        return finalize(cachedBody);
      }
      // Same adopt-before-throw posture as My Updates · Comix: after a solved
      // challenge the app harvest often dies with WKError and leaves
      // cf_clearance only in the shared WK store. Without adopting here,
      // chapter refresh re-throws CloudflareError forever even though force
      // (which resets cooldown) looks fine.
      if (!this.hasComixBrowserSession()) {
        const adopted = await this.adoptComixClearanceFromStore();
        console.log(
          `[manifold] comix-direct: adopt before chapters=${adopted} session=${this.hasComixBrowserSession()}`,
        );
      }
      try {
        const chapters = await this.comix.fetchChaptersByHid(comixPageId, sourceManga);
        writeChapterListBody(bodyKey, chapters);
        return finalize(chapters);
      } catch (error) {
        if (!(error instanceof CloudflareError)) {throw error;}
        // One more silent adopt after a challenge mid-fetch, then rethrow so
        // Paperback still opens the bypass sheet with a bare-origin request.
        if (!this.hasComixBrowserSession()) {
          await this.adoptComixClearanceFromStore();
        }
        throw new CloudflareError(
          await comixBypassRequest(),
          "Comix Cloudflare bypass — complete the browser challenge",
        );
      }
    }

    const loadMangadex = async (options?: { readonly bypassBodyCache?: boolean }): Promise<Chapter[]> => {
      if (provider?.provider !== "mangadex") {return [];}
      const bodyKey = chapterListCacheKey(sourceManga.mangaId, "mangadex", provider.externalId);
      if (!options?.bypassBodyCache) {
        const cachedBody = readChapterListBody(bodyKey, sourceManga);
        if (cachedBody) {
          console.log(
            `[manifold] chapters body cache hit:${sourceManga.mangaId}:mangadex:${cachedBody.length}`,
          );
          return cachedBody;
        }
      }
      try {
        const chapters = await Effect.runPromise(this.mangaDex.getChapters(provider.externalId));
        const mapped = toMangaDexChapters(sourceManga, chapters);
        writeChapterListBody(bodyKey, mapped);
        return mapped;
      } catch (error) {
        console.error(
          `[manifold] mangadex chapters failed:${sourceManga.mangaId}:${errorMessage(error)}`,
        );
        return [];
      }
    };

    const titles = [
      sourceManga.mangaInfo.primaryTitle,
      ...sourceManga.mangaInfo.secondaryTitles,
    ];
    let comixFailed = false;
    let comixHid: string | undefined;
    let comixCloudflareError: CloudflareError | undefined;
    const resolveComixHid = async (): Promise<string | undefined> => {
      // Registry / device hid cache first — avoids a browse WebView sweep.
      const hidKey = `comix-hid:${sourceManga.mangaId}`;
      const rawHid = Application.getState(hidKey);
      if (isString(rawHid) && rawHid.length > 0) {
        try {
          // SAFETY: I/O JSON.parse of the chapter-list Comix hid cache blob.
          const parsed: unknown = JSON.parse(rawHid);
          if (isJsonObject(parsed) && isString(parsed.hid) && parsed.hid.length > 0) {
            return parsed.hid;
          }
        } catch {
          // fall through
        }
      }
      const stored = await configuredPersonalApi()
        .getEntry(sourceManga.mangaId)
        .catch(() => undefined);
      const link = stored?.providers.find((entry) => entry.provider === "comix");
      if (link?.externalId) {return link.externalId;}
      const resolved = await this.comix.resolveHid(titles);
      return resolved.hid;
    };
    const loadComix = async (options?: { readonly bypassBodyCache?: boolean }): Promise<Chapter[]> => {
      try {
        const hid = await resolveComixHid();
        if (!hid) {return [];}
        comixHid = hid;
        const bodyKey = chapterListCacheKey(sourceManga.mangaId, "comix", hid);
        if (!options?.bypassBodyCache) {
          const cachedBody = readChapterListBody(bodyKey, sourceManga);
          if (cachedBody) {
            console.log(
              `[manifold] chapters body cache hit:${sourceManga.mangaId}:comix:${cachedBody.length}`,
            );
            return cachedBody;
          }
        }
        const chapters = await this.comix.fetchChaptersByHid(hid, sourceManga);
        writeChapterListBody(bodyKey, chapters);
        return chapters;
      } catch (error) {
        console.error(`[manifold] comix fallback failed:${sourceManga.mangaId}:${errorMessage(error)}`);
        // A Cloudflare challenge only kills the update when MangaDex has
        // nothing to offer; verified-MD titles must keep updating.
        if (error instanceof CloudflareError) {
          comixCloudflareError = error;
          comixFailed = true;
          return [];
        }
        comixFailed = true;
        return [];
      }
    };
    const loadComixCached = async (
      hid?: string,
      options?: { readonly bypassBodyCache?: boolean },
    ): Promise<Chapter[]> => {
      if (hid) {
        const bodyKey = chapterListCacheKey(sourceManga.mangaId, "comix", hid);
        if (!options?.bypassBodyCache) {
          const cachedBody = readChapterListBody(bodyKey, sourceManga);
          if (cachedBody) {
            console.log(
              `[manifold] chapters body cache hit:${sourceManga.mangaId}:comix:${cachedBody.length}`,
            );
            comixHid = hid;
            return cachedBody;
          }
        }
        try {
          const chapters = await this.comix.fetchChaptersByHid(hid, sourceManga);
          if (chapters.length > 0) {
            comixHid = hid;
            writeChapterListBody(bodyKey, chapters);
            return chapters;
          }
          console.log(`[manifold] comix cached hid empty, falling back to search:${sourceManga.mangaId}:${hid}`);
        } catch (error) {
          console.error(`[manifold] comix cached hid failed:${sourceManga.mangaId}:${errorMessage(error)}`);
          if (error instanceof CloudflareError) {throw error;}
        }
      }
      return loadComix(options);
    };

    // Force order: registry per-title pin (max prio) → device default → auto
    // heuristic (MangaDex trust + richer-list). Forced pins skip comparison
    // so incomplete MangaDex catalogs (still >= trust threshold) can be
    // overridden to Comix, and a device-wide mangadex/comix default can skip
    // the dual-fetch fallback without touching registry rows.
    const forcedSource = await (async (): Promise<
      | { provider: "mangadex" | "comix"; via: "registry" | "device" }
      | undefined
    > => {
      if (!UUID_RE.test(sourceManga.mangaId)) {return undefined;}
      const pinKey = `chapter-source-pin:v1:${sourceManga.mangaId}`;
      const PIN_TTL_MS = 5 * 60 * 1000;
      let previousPin: ChapterSourceChoice | undefined;
      const deviceForce = ():
        | { provider: "mangadex" | "comix"; via: "device" }
        | undefined => {
        const forcedProvider = chapterSourceForceOrUndefined(readChapterSourceDefault());
        return forcedProvider ? { provider: forcedProvider, via: "device" } : undefined;
      };
      const rawPin = Application.getState(pinKey);
      if (isString(rawPin) && rawPin.length > 0) {
        try {
          // SAFETY: I/O JSON.parse of the chapter-source force pin cache.
          const parsed: unknown = JSON.parse(rawPin);
          if (isJsonObject(parsed)) {
            previousPin = isString(parsed.p) ? parseChapterSourceChoice(parsed.p) : undefined;
            if (
              isFiniteNumber(parsed.t) &&
              Date.now() - parsed.t < PIN_TTL_MS &&
              previousPin !== undefined
            ) {
              // Registry force wins; cached "auto" still applies the device default.
              const registryForce = chapterSourceForceOrUndefined(previousPin);
              if (registryForce) {
                return { provider: registryForce, via: "registry" };
              }
              return deviceForce();
            }
          }
        } catch {
          // fall through to registry
        }
      }
      const stored = await configuredPersonalApi()
        .getEntry(sourceManga.mangaId)
        .catch(() => undefined);
      const registryPin =
        stored?.chapterSource !== undefined
          ? (parseChapterSourceChoice(stored.chapterSource) ?? "auto")
          : "auto";
      Application.setState(JSON.stringify({ p: registryPin, t: Date.now() }), pinKey);
      // Only drop the choice cache when leaving a force pin, so auto titles
      // keep their MangaDex-trust cache across pin revalidations.
      if (
        registryPin === "auto" &&
        (previousPin === "mangadex" || previousPin === "comix")
      ) {
        Application.setState("", choiceKey);
      }
      const registryForce = chapterSourceForceOrUndefined(registryPin);
      if (registryForce) {
        return { provider: registryForce, via: "registry" };
      }
      return deviceForce();
    })();
    if (forcedSource?.provider === "comix") {
      const chapters = await loadComixCached(
        cachedChoice?.p === "comix" ? cachedChoice.h : undefined,
      );
      if (chapters.length === 0 && comixCloudflareError) {
        throw comixCloudflareError;
      }
      Application.setState(
        JSON.stringify({
          p: "comix",
          t: Date.now(),
          ttl: chapters.length === 0 ? FAILED_RETRY_TTL_MS : CHOICE_TTL_MS,
          n: chapters.length,
          e: chapterSourceEpoch,
          ...(comixHid && { h: comixHid }),
        }),
        choiceKey,
      );
      console.log(
        `[manifold] chapters source:${sourceManga.mangaId}:comix-forced-${forcedSource.via}:${chapters.length}`,
      );
      return finalize(chapters);
    }
    if (forcedSource?.provider === "mangadex") {
      const chapters = await loadMangadex();
      Application.setState(
        JSON.stringify({
          p: "mangadex",
          t: Date.now(),
          ttl: MANGADEX_RECHECK_TTL_MS,
          n: chapters.length,
          e: chapterSourceEpoch,
        }),
        choiceKey,
      );
      console.log(
        `[manifold] chapters source:${sourceManga.mangaId}:mangadex-forced-${forcedSource.via}:${chapters.length}`,
      );
      return finalize(chapters);
    }

    if (choiceFresh && cachedChoice) {
      console.log(
        `[manifold] chapters source:${sourceManga.mangaId}:${cachedChoice.p}:cached${cachedChoice.h ? `:${cachedChoice.h}` : ""}`,
      );
      if (cachedChoice.p === "comix") {
        const chapters = await loadComixCached(cachedChoice.h);
        if (!cachedChoice.h && comixHid) {
          Application.setState(
            JSON.stringify({
              p: cachedChoice.p,
              t: Date.now(),
              ttl: cachedChoice.ttl,
              n: chapters.length,
              e: chapterSourceEpoch,
              h: comixHid,
            }),
            choiceKey,
          );
          console.log(`[manifold] cached hid backfilled:${sourceManga.mangaId}:${comixHid}`);
        }
        return finalize(chapters);
      }
      return finalize(await loadMangadex());
    }

    const mangadexChapters = await loadMangadex();
    if (mangadexChapters.length >= MANGADEX_TRUST_THRESHOLD) {
      // MangaDex clearly serves this title — skip the Comix comparison
      // entirely. Bulk library passes otherwise fire thousands of WebView
      // captures at comix.to, which trips Cloudflare mid-run. The only cost:
      // titles where Comix lists far more chapters than MangaDex re-check
      // on the next recompare TTL instead of immediately.
      const ttlMs = MANGADEX_RECHECK_TTL_MS;
      Application.setState(
        JSON.stringify({
          p: "mangadex",
          t: Date.now(),
          ttl: ttlMs,
          n: mangadexChapters.length,
          e: chapterSourceEpoch,
        }),
        choiceKey,
      );
      console.log(
        `[manifold] chapters source:${sourceManga.mangaId}:mangadex-trusted:${mangadexChapters.length}:ttl=${Math.round(ttlMs / 60000)}m`,
      );
      return finalize(mangadexChapters);
    }
    const comixChapters = await loadComix();
    if (
      mangadexChapters.length === 0 &&
      comixChapters.length === 0 &&
      comixCloudflareError
    ) {
      // Neither source served chapters and Comix is behind a challenge —
      // surface it so Paperback offers the bypass WebView.
      throw comixCloudflareError;
    }
    const useComix = comixChapters.length > mangadexChapters.length;
    const best = useComix ? comixChapters : mangadexChapters;
    // Never pin an empty source for hours — that produced permanent
    // "no chapters found" after a bad Comix unwrap (mangadex:0 / 360m).
    if (best.length === 0) {
      Application.setState(
        JSON.stringify({
          p: useComix ? "comix" : "mangadex",
          t: Date.now(),
          ttl: FAILED_RETRY_TTL_MS,
          n: 0,
          e: chapterSourceEpoch,
          ...(useComix && comixHid && { h: comixHid }),
        }),
        choiceKey,
      );
      console.log(
        `[manifold] chapters source:${sourceManga.mangaId}:empty:ttl=${Math.round(FAILED_RETRY_TTL_MS / 60000)}m${comixFailed ? ":failed" : ""}`,
      );
      return finalize([]);
    }
    const ttlMs = useComix
      ? CHOICE_TTL_MS
      : comixFailed
        ? FAILED_RETRY_TTL_MS
        : MANGADEX_RECHECK_TTL_MS;
    Application.setState(
      JSON.stringify({
        p: useComix ? "comix" : "mangadex",
        t: Date.now(),
        ttl: ttlMs,
        n: best.length,
        e: chapterSourceEpoch,
        ...(useComix && comixHid && { h: comixHid }),
      }),
      choiceKey,
    );
    console.log(
      `[manifold] chapters source:${sourceManga.mangaId}:${useComix ? "comix" : "mangadex"}:${best.length}:ttl=${Math.round(ttlMs / 60000)}m${comixFailed ? ":failed" : ""}`,
    );
    return finalize(best);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    if (isComixChapterId(chapter.chapterId)) {
      return this.comix.getChapterDetails(chapter);
    }
    const provider = providerFromInfo(chapter.sourceManga);
    if (!provider || provider.provider !== "mangadex") {
      throw new Error("This chapter has no verified MangaDex provider link");
    }
    const details = await Effect.runPromise(this.mangaDex.getChapterDetails(chapter.chapterId));
    return toMangaDexChapterDetails(chapter, details);
  }

  async getSettingsForm(): Promise<PaperbackForm> {
    return new ManifoldSettingsForm(this);
  }
}

class ManifoldAdvancedSearchForm extends AdvancedSearchForm {
  getSections() {
    return [
      FlowSection(
        {
          id: "manga-sync-search",
          header: "Search filters",
          footer: "manifold searches AniList titles and opens verified MangaDex chapters.",
        },
        [
          LabelRow("manga-sync-search-info", {
            title: "No additional filters",
            value: "Leave filters unchanged to search AniList canonical titles.",
          }),
        ],
      ),
    ];
  }

  getSearchQueryMetadata(): Metadata {
    return {};
  }
}

class ManifoldSettingsForm extends Form {
  readonly requiresExplicitSubmission = true;

  private pendingPersonalApiToken?: string;
  private pendingAniListToken?: string;
  private pendingComixCommand?: string;
  private pendingChapterSourceDefault?: string;

  constructor(private readonly source: ManifoldSourceImpl) {
    super();
  }

  getSections() {
    // iOS 27 probe: original bisect only cleared InputRow + plain LabelRow.
    // ButtonRow, LabelRow+onSelect, OAuthButtonRow, WebViewRow, and LabelRow
    // style/subtitle have all been implicated. This build is the known-safe
    // floor: Section + plain labels + text inputs. Comix actions via command.
    // No keychain reads in getSections.
    const apiStatus =
      // SAFETY: Paperback secure/state store returns ned) ?? "Not configured"; const aniListStatus = (Applicat for this key
      (Application.getState(MANIFOLD_API_STATUS_KEY) as string | undefined) ?? "Not configured";
    const aniListStatus =
      // SAFETY: Paperback secure/state store returns ?? "Not connected"; const comixStatus = this.source.hasCom for this key
      (Application.getState(ANILIST_STATUS_KEY) as string | undefined) ?? "Not connected";
    const comixStatus = this.source.hasComixBrowserSession() ? "session ok" : "no session";
    const chapterSourceDefault = readChapterSourceDefault();
    // SAFETY: value is asserted type at this site
    return [
      Section(
        {
          id: "settings-minimal",
          header: `manifold: source ${info.version}`,
          footer:
            "iOS 27-safe settings. Chapter source: auto / mangadex / comix (device default; registry pins still win). Comix: clear / adopt / force — then Save. If My Updates · Comix stays empty after a solve, run adopt or force here (Discover often hides the CF banner).",
        },
        [
          LabelRow("build-id", {
            title: "Build",
            value: info.version,
          }),
          LabelRow("personal-api-status", {
            title: "Personal API",
            value: apiStatus,
          }),
          InputRow("personal-api-token", {
            title: "API token",
            value: "",
            onValueChange: Application.Selector(this as ManifoldSettingsForm, "tokenChanged"),
          }),
          // SAFETY: value matches LabelRow("anilist-status at this call site
          LabelRow("anilist-status", {
            title: "AniList",
            value: aniListStatus,
          }),
          InputRow("anilist-token", {
            title: "AniList token",
            value: "",
            onValueChange: Application.Selector(this as ManifoldSettingsForm, "aniListTokenChanged"),
          // SAFETY: value matches LabelRow("comix-s at this call site
          }),
          LabelRow("chapter-source-default-status", {
            title: "Chapter source",
            value: chapterSourceDefault,
          }),
          InputRow("chapter-source-default", {
            title: "Chapter source (auto|mangadex|comix)",
            value: "",
            onValueChange: Application.Selector(
              this as ManifoldSettingsForm,
              "chapterSourceDefaultChanged",
            ),
          }),
          LabelRow("comix-status", {
            title: "Comix",
            value: comixStatus,
          }),
          InputRow("comix-command", {
            title: "Comix command",
            value: "",
            onValueChange: Application.Selector(
              this as ManifoldSettingsForm,
              "comixCommandChanged",
            // SAFETY: value matches ), }), at this call site
            ),
          }),
        ],
      ),
    ];
  }

  readonly tokenChanged = async (value: string): Promise<void> => {
    // Buffer only. Persisting or reloading the form from inside a text-row
    // callback crashes Paperback's native UI while the row is editing.
    this.pendingPersonalApiToken = value;
  };

  readonly aniListTokenChanged = async (value: string): Promise<void> => {
    this.pendingAniListToken = value;
  };

  readonly comixCommandChanged = async (value: string): Promise<void> => {
    this.pendingComixCommand = value;
  };

  readonly chapterSourceDefaultChanged = async (value: string): Promise<void> => {
    this.pendingChapterSourceDefault = value;
  };

  override async formDidSubmit(): Promise<void> {
    const personalToken = this.pendingPersonalApiToken?.trim();
    if (personalToken) {
      Application.setSecureState(personalToken, MANIFOLD_API_TOKEN_KEY);
      Application.setState("Configured", MANIFOLD_API_STATUS_KEY);
    }

    const aniListToken = this.pendingAniListToken?.trim();
    if (aniListToken) {
      try {
        const viewer = await aniListRequest<AniListViewer>(aniListToken, viewerQuery);
        Application.setSecureState(aniListToken, ANILIST_SESSION_KEY);
        Application.setState(viewer.Viewer.id, ANILIST_VIEWER_ID_KEY);
        Application.setState("Connected", ANILIST_STATUS_KEY);
      } catch (error) {
        console.error(`[manifold] AniList connect failed: ${errorMessage(error)}`);
        const rejected = error instanceof AniListUnauthorizedError;
        Application.setState(
          rejected ? "Token rejected — capture a fresh one" : "Connect failed — try again",
          ANILIST_STATUS_KEY,
        );
      }
    }

    const comixCommand = this.pendingComixCommand?.trim().toLowerCase();
    const chapterSourceRaw = this.pendingChapterSourceDefault?.trim().toLowerCase();
    this.pendingPersonalApiToken = undefined;
    this.pendingAniListToken = undefined;
    this.pendingComixCommand = undefined;
    this.pendingChapterSourceDefault = undefined;

    if (chapterSourceRaw) {
      const next = parseChapterSourceChoice(chapterSourceRaw);
      if (next) {
        const previous = readChapterSourceDefault();
        if (previous !== next) {
          Application.setState(next, CHAPTER_SOURCE_DEFAULT_KEY);
          // Invalidate comix-source-choice:v2 pins so auto titles re-resolve
          // instead of keeping a previous device-forced provider for hours.
          bumpChapterSourceEpoch();
          console.log(
            `[manifold] chapter source default:${previous}->${next}:epoch=${readChapterSourceEpoch()}`,
          );
        }
      } else {
        console.error(
          `[manifold] chapter source default ignored (use auto|mangadex|comix):${chapterSourceRaw}`,
        );
      }
    }

    if (comixCommand === "clear") {
      this.source.clearComixSession();
      this.reloadForm();
      return;
    }
    if (comixCommand === "adopt") {
      await this.source.adoptComixClearanceFromStore();
      this.reloadForm();
      return;
    }
    if (comixCommand === "force") {
      // Throws CloudflareError — do not reload afterward.
      await this.source.forceComixCloudflareBypass();
    }

    this.reloadForm();
  }
}

// The exported instance's name must match the extension id (the source
// folder name): Paperback resolves `source.<id>` when loading the bundle.
export class ManifoldSourceExtension extends ManifoldSourceImpl {}

export const ManifoldSource = new ManifoldSourceExtension();
