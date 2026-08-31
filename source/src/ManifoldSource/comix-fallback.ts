import {
  CloudflareError,
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type Request,
  type SourceManga,
} from "@paperback/types";
import { toChapter, toChapterDetails } from "@manifold/paperback-comix/parser";
import { normalizeTitle } from "./mapper.js";

type JsonObject = Record<string, unknown>;

export const COMIX_ORIGIN = "https://comix.to";
export const COMIX_CHAPTER_PREFIX = "comix:";

const CAPTURE_TIMEOUT_MS = 15_000;

export const isComixChapterId = (chapterId: string): boolean =>
  chapterId.startsWith(COMIX_CHAPTER_PREFIX);

export const rawComixChapterId = (chapterId: string): string =>
  chapterId.slice(COMIX_CHAPTER_PREFIX.length);

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asText = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

const asDateValue = (value: unknown): Date | undefined => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {return value;}
  if (typeof value !== "string" && typeof value !== "number") {return undefined;}
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
};

const numberLike = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {return value;}
  if (typeof value !== "string") {return undefined;}
  const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isChallenge = (body: string): boolean => {
  const normalized = body.toLowerCase();
  return normalized.includes("just a moment") ||
    normalized.includes("cf-chl-") ||
    normalized.includes("challenge-platform") ||
    normalized.includes("_cf_chl_");
};

interface SearchItem extends JsonObject {
  readonly title?: unknown;
  readonly altTitles?: unknown;
  readonly hid?: unknown;
  readonly hash_id?: unknown;
  readonly slug?: unknown;
  readonly url?: unknown;
}

const altTitlesOf = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((title): title is string => typeof title === "string")
    : [];

const tokenize = (value: string): readonly string[] =>
  value.split(" ").filter(Boolean);

// Prefix stemming: "villains"/"villainess" share the "villain" stem.
const tokensCompatible = (a: string, b: string): boolean => {
  if (a === b) {return true;}
  const lcp = (() => {
    let i = 0;
    const m = Math.min(a.length, b.length);
    while (i < m && a.charCodeAt(i) === b.charCodeAt(i)) {i += 1;}
    return i;
  })();
  return lcp >= 4;
};

export const pickComixMatch = (
  items: readonly SearchItem[],
  titles: readonly string[],
  exactOnly = false,
): SearchItem | undefined => {
  const candidates = titles.map(normalizeTitle).filter(Boolean);
  let best: SearchItem | undefined;
  let bestScore = 0;
  for (const item of items) {
    const names = [
      normalizeTitle(asString(item.title)),
      ...altTitlesOf(item.altTitles).map(normalizeTitle),
    ].filter(Boolean);
    for (const candidate of candidates) {
      for (const name of names) {
        if (name === candidate) {return item;}
        if (exactOnly) {continue;}
        const candidateTokens = tokenize(candidate);
        if (candidateTokens.length === 0) {continue;}
        let hits = 0;
        for (const token of candidateTokens) {
          if (name.split(" ").some((n) => tokensCompatible(n, token))) {hits += 1;}
        }
        const score = hits / candidateTokens.length;
        if (score >= 0.65 && score > bestScore) {
          best = item;
          bestScore = score;
        }
      }
    }
  }
  return best;
};

export const toSyncComixChapters = (
  items: readonly JsonObject[],
  sourceManga: SourceManga,
): Chapter[] => {
  // Multiple scanlation groups release the same chapter number; keep the
  // first listing per language+number so readers see one entry each.
  const seenNumbers = new Set<string>();
  return items
    .map((item) => toChapter(item, sourceManga))
    .filter((chapter) => chapter.chapterId.length > 0)
    .filter((chapter) => {
      const key = `${chapter.langCode}:${chapter.chapNum}`;
      if (seenNumbers.has(key)) {return false;}
      seenNumbers.add(key);
      return true;
    })
    .map((chapter) => ({
      ...chapter,
      // Paperback sorts by sortingIndex first; without it the capture's
      // parse order (widgets before pagination) scrambles the list.
      sortingIndex: chapter.chapNum,
      chapterId: `${COMIX_CHAPTER_PREFIX}${chapter.chapterId}`,
      additionalInfo: {
        ...chapter.additionalInfo,
        ...(!chapter.additionalInfo?.["Comix chapter URL"]
          ? {
              "Comix chapter URL":
                `${COMIX_ORIGIN}/chapter/${rawComixChapterIdSafe(chapter.chapterId)}`,
            }
          : {}),
      },
    }))
    .sort((a, b) => a.chapNum - b.chapNum);
};

const rawComixChapterIdSafe = (chapterId: string): string =>
  chapterId.startsWith(COMIX_CHAPTER_PREFIX) ? rawComixChapterId(chapterId) : chapterId;

export interface ComixSession {
  readonly cookies: () => readonly Cookie[];
  readonly setCookies: (cookies: readonly Cookie[]) => void;
}

const clearanceHeader = (cookies: readonly Cookie[]): Record<string, string> => {
  // Only cf_clearance may be sent explicitly; login/session cookies make
  // comix's backend demand CSRF tokens. URLSession merges shared-store
  // cookies after this header, but comix honours a clean clearance pair.
  const jar = cookies
    .filter((cookie) => cookie.name === "cf_clearance")
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return jar.length > 0 ? { cookie: jar.join("; ") } : {};
};

// After a challenge, back off before touching comix.to again: hammering a
// challenged host re-trips Cloudflare and burns the freshly solved clearance.
const CHALLENGE_COOLDOWN_MS = 45_000;
let comixCooldownUntil = 0;
// Set when captures prove the WebView session is broken (no page state) and
// self-healing failed; every queued capture then fails fast until a bypass
// completes or a capture succeeds again.
let sessionBroken = false;

export const comixChallenged = (): boolean =>
  Date.now() < comixCooldownUntil || sessionBroken;

export const resetComixCooldown = (): void => {
  comixCooldownUntil = 0;
  sessionBroken = false;
};

const requestHtml = async (
  session: ComixSession,
  url: string,
): Promise<string> => {
  if (comixChallenged()) {
    throw new CloudflareError({
      url: COMIX_ORIGIN,
      method: "GET",
      headers: {
        "user-agent": await Application.getDefaultUserAgent(),
      },
    });
  }
  const request: Request = {
    url,
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml",
      referer: `${COMIX_ORIGIN}/`,
      "user-agent": await Application.getDefaultUserAgent(),
      ...clearanceHeader(session.cookies()),
    },
  };
  const [response, bodyBuffer] = await Application.scheduleRequest(request);
  const html = Application.arrayBufferToUTF8String(bodyBuffer);
  const challenged =
    response.headers?.["cf-mitigated"] === "challenge" ||
    response.status === 403 ||
    response.status === 503 ||
    isChallenge(html);
  if (challenged) {
    comixCooldownUntil = Date.now() + CHALLENGE_COOLDOWN_MS;
    throw new CloudflareError({
      url: COMIX_ORIGIN,
      method: "GET",
      headers: {
        "user-agent": await Application.getDefaultUserAgent(),
      },
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Comix page request failed with HTTP ${response.status}: ${url}`);
  }
  comixCooldownUntil = 0;
  return html;
};

// comix.to's JSON API requires a per-request `_=` signature produced by its
// own obfuscated bundle, so direct calls always answer 403 Missing token.
// Instead we run the real site page in a WebView, hook JSON.parse, and
// capture the decrypted payloads the site fetches for itself.

// Concurrent WebViews clash (Paperback's own harvest injection can abort
// ours), and library refreshes fire several titles at once — captures are
// serialized and retried once when the page produced nothing. A gap between
// page loads keeps the WebView traffic itself from re-tripping Cloudflare
// (the request limiter only paces the raw HTML fetches).
const WEBVIEW_PACING_MS = 1_200;
let webViewQueue: Promise<unknown> = Promise.resolve();
const enqueueWebView = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = webViewQueue.then(async () => {
    await Application.sleep(WEBVIEW_PACING_MS / 1000);
    return task();
  });
  webViewQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const captureViaSiteBundle = async (
  session: ComixSession,
  pageUrl: string,
  bootstrap: string,
): Promise<unknown> => {
  // Inject contract copied from inkdex/general-extensions 0.9/stable Comix:
  // the bootstrap resolves window.__comixResult__ with {r: payload} on a
  // captured match, {r: null} on timeout, and the inject is a bare
  // `return window.__comixResult__` — that exact shape is proven to work on
  // this app version, while wrapper expressions can come back as
  // `result === undefined`.
  const runOnce = async (): Promise<{ r?: unknown } | null | undefined> => {
    const html = await requestHtml(session, pageUrl);
    const headOpen = /<head[^>]*>/i.exec(html);
    const withBootstrap = headOpen !== null
      ? html.replace(headOpen[0], `${headOpen[0]}<script>${bootstrap}</script>`)
      : `<script>${bootstrap}</script>${html}`;

    const execution = await Application.executeInWebView({
      source: {
        html: withBootstrap,
        baseUrl: pageUrl,
        loadCSS: false,
        loadImages: false,
        userAgent: await Application.getDefaultUserAgent(),
      },
      inject: "return window.__comixResult__",
      storage: { cookies: [...session.cookies()] },
    });
    session.setCookies(execution.storage.cookies);
    return execution.result as { r?: unknown } | null | undefined;
  };

  const attempt = async (): Promise<{ r?: unknown } | null | undefined> =>
    enqueueWebView(runOnce);

  const hasPayload = (value: { r?: unknown } | null | undefined): value is { r: unknown } =>
    value !== undefined && value !== null && value.r !== undefined && value.r !== null;

  let wrapped = await attempt();
  if (!hasPayload(wrapped)) {
    console.log(`[manifold] comix capture retry:${pageUrl.slice(0, 90)}`);
    wrapped = await attempt();
  }
  console.log(
    `[manifold] comix capture:${pageUrl.slice(0, 90)}:result=${
      wrapped === undefined ? "undefined" : wrapped === null ? "timeout" : "payload"
    }`,
  );
  if (hasPayload(wrapped)) {
    sessionBroken = false;
    return wrapped.r;
  }
  // No payload at all: either the inject never settled (killed webview) or
  // the page never produced a matching JSON (challenge interstitial, dead
  // page). The app's own bypass harvest often dies right after a solved
  // challenge (WKError "Return statements..."), leaving the fresh clearance
  // only in the shared WebView store: probe the store, adopt any clearance
  // we lack, and retry exactly once. If the session is still dead, back off
  // and surface the challenge instead of sweeping every title into silent
  // misses. Legit misses (empty search/chapter lists) resolve a payload and
  // never reach this path.
  const healed = await recoverCookiesFromStore(session);
  if (healed) {
    console.log(`[manifold] comix capture heal-retry:${pageUrl.slice(0, 90)}`);
    wrapped = await attempt();
  }
  if (hasPayload(wrapped)) {
    sessionBroken = false;
    return wrapped.r;
  }
  sessionBroken = true;
  comixCooldownUntil = Date.now() + CHALLENGE_COOLDOWN_MS;
  throw new CloudflareError(
    {
      url: COMIX_ORIGIN,
      method: "GET",
      headers: {
        "user-agent": await Application.getDefaultUserAgent(),
      },
    },
    "Comix capture produced no page state — complete the browser challenge",
  );
};

// The app's bypass harvest can die with a WKError after the challenge is
// solved, leaving the fresh clearance only in the shared WebView cookie
// store. A minimal same-origin webview round-trips that store back to us.
const recoverCookiesFromStore = async (session: ComixSession): Promise<boolean> => {
  try {
    const execution = await Application.executeInWebView({
      source: {
        html: "<!doctype html><title>comix-session-recovery</title>",
        baseUrl: `${COMIX_ORIGIN}/`,
        loadCSS: false,
        loadImages: false,
        userAgent: await Application.getDefaultUserAgent(),
      },
      inject: "document.title",
      storage: { cookies: [...session.cookies()] },
    });
    const current = new Set(
      session.cookies()
        .filter((cookie) => cookie.name === "cf_clearance")
        .map((cookie) => cookie.value),
    );
    const fresh = execution.storage.cookies.filter(
      (cookie) =>
        cookie.name === "cf_clearance" &&
        cookie.value.length > 0 &&
        !current.has(cookie.value),
    );
    if (fresh.length === 0) {return false;}
    session.setCookies([...session.cookies(), ...fresh]);
    console.log(`[manifold] comix session recovered:${fresh.length} clearance cookie(s)`);
    return true;
  } catch (error) {
    console.error(
      `[manifold] comix session recovery failed:${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};

const captureBootstrap = (matchExpr: string): string => `
(function(){
  var done=false; var doneResolve;
  window.__comixResult__=new Promise(function(r){doneResolve=r});
  function finish(v){if(done)return;done=true;doneResolve({r:v})}
  var orig=JSON.parse;
  JSON.parse=new Proxy(orig,{apply:function(t,a,args){
    var parsed=Reflect.apply(t,a,args);
    try{
      if(done) return parsed;
      if((${matchExpr})(parsed)) finish(args[0]);
    }catch(e){}
    return parsed;
  }});
  setTimeout(function(){finish(null)},${CAPTURE_TIMEOUT_MS});
})();`;

// Any result envelope counts, even an empty one: a valid-but-empty search or
// chapter list must resolve (a clean miss), while a challenge interstitial
// produces no payload at all and times out (a session-level failure).
const SEARCH_MATCHER =
  "(function(p){var r=p&&p.result;return !!(r&&Array.isArray(r.items))})";

const PAGES_MATCHER =
  "(function(p){var r=p&&p.result;return !!(r&&r.pages)})";

// Chapter-list payloads (title pages) carry the same result.items shape as
// search; the first page lists the most recent chapters, which is all the
// My Updates probe needs — no pagination clicking.
const LATEST_MATCHER =
  "(function(p){var r=p&&p.result;return !!(r&&Array.isArray(r.items))})";

// Chapter lists paginate via Next buttons; each page fetch carries its own
// signature, so pagination must happen through real clicks. Payloads may
// omit meta.page entirely — dedupe by chapter id instead of page numbers.
const CHAPTERS_BOOTSTRAP = `
(function(){
  var items=[];var seen={};var done=false;var doneResolve;var idle=null;
  var pageCursor=1;var clickFails=0;
  window.__comixResult__=new Promise(function(r){doneResolve=r});
  function finish(v){if(done)return;done=true;doneResolve({r:v})}
  function armIdle(){if(idle)clearTimeout(idle);idle=setTimeout(function(){finish(items)},8000)}
  setTimeout(function(){finish(items)},60000);
  function clickNext(){
    var candidates=document.querySelectorAll('button, a, [role="button"]');
    for(var i=0;i<candidates.length;i++){
      var b=candidates[i];
      if(b.disabled || b.getAttribute('aria-disabled')==='true')continue;
      var label=[b.getAttribute('aria-label'),b.getAttribute('title'),b.textContent]
        .filter(Boolean).join(' ');
      if(/\\bnext\\b/i.test(label) || /\\b»\\b/.test(label) || /\\b›\\b/.test(label) || label.trim()==='>') {b.click();return true;}
      // Some themes use an icon-only next button without text but with svg use
      var html=(b.innerHTML||'').toLowerCase();
      if(html.indexOf('chevron-right')!==-1 || html.indexOf('arrow-right')!==-1){b.click();return true;}
    }
    for(var j=0;j<candidates.length;j++){
      var b2=candidates[j];
      if(b2.disabled || b2.getAttribute('aria-disabled')==='true')continue;
      var txt=(b2.textContent||'').trim();
      if(parseInt(txt,10)===pageCursor+1){b2.click();return true;}
    }
    return false;
  }
  function tryAdvance(){
    if(done)return false;
    if(clickNext()){armIdle();return true;}
    clickFails++;
    if(clickFails>12){finish(items);return true;}
    setTimeout(tryAdvance,250);
    return false;
  }
  var orig=JSON.parse;
  JSON.parse=new Proxy(orig,{apply:function(t,a,args){
    var parsed=Reflect.apply(t,a,args);
    try{
      var r=parsed&&parsed.result;
      if(!done&&r&&Array.isArray(r.items)&&r.items.length>=1&&r.items[0]&&r.items[0].mangaId!==undefined){
        console.log('[manifold] comix chapter batch:'+r.items.length+':'+(r.items[0]&&r.items[0].mangaId));
        var added=0;
        for(var i=0;i<r.items.length;i++){
          var it=r.items[i];var id=String(it.id);
          if(!seen[id]){seen[id]=1;items.push(it);added++;}
        }
        var meta=r.meta||r.pagination||{};
        var p=meta.page||meta.current_page;
        if(typeof p==='number'&&p>=pageCursor)pageCursor=p;
        if(added>0){armIdle();setTimeout(tryAdvance,300);}
      }
    }catch(e){}
    return parsed;
  }});
  armIdle();
})();`;

// Comix server-renders page state into `<script type="application/json"
// id="initial-data">` as a React-Query cache: `{ queries: { '["manga",
// "detail","{hid}"]': <manga object> } }`. Detail pages embed the manga here
// because the JSON API is 403; guard for a `{ result }` wrapper too.
const INITIAL_DATA_SCRIPT =
  /<script[^>]*id="initial-data"[^>]*>([\s\S]*?)<\/script>/i;

type DetailManga = JsonObject;

const detailMangaFromHtml = (html: string): DetailManga | undefined => {
  const raw = INITIAL_DATA_SCRIPT.exec(html)?.[1];
  if (!raw) {return undefined;}
  try {
    const queries = (JSON.parse(raw) as { queries?: Record<string, unknown> }).queries;
    if (!queries) {return undefined;}
    const key = Object.keys(queries).find((candidate) => candidate.includes('"detail"'));
    if (!key) {return undefined;}
    const value = queries[key] as DetailManga & { result?: DetailManga };
    const manga = value?.result ?? value;
    return manga && manga.hid !== undefined ? manga : undefined;
  } catch {
    return undefined;
  }
};

const detailPosterUrl = (manga: DetailManga): string => {
  const poster = manga.poster;
  if (typeof poster !== "object" || poster === null) {return "";}
  const record = poster as JsonObject;
  return asText(record.large) || asText(record.medium) || asText(record.small);
};

const comixSourceManga = (mangaId: string, manga: DetailManga): SourceManga => {
  const hid = mangaId.split("-")[0] || mangaId;
  return {
    mangaId,
    mangaInfo: {
      thumbnailUrl: detailPosterUrl(manga),
      synopsis: asText(manga.synopsis),
      primaryTitle: asText(manga.title) || "Untitled",
      secondaryTitles: [...altTitlesOf(manga.altTitles)],
      contentRating: ContentRating.MATURE,
      ...(asText(manga.status) ? { status: asText(manga.status) } : {}),
      additionalInfo: {
        "manifold provider": "comix",
        "manifold provider ID": hid,
      },
    },
  };
};

/** Normalize CHAPTERS_BOOTSTRAP / captureViaSiteBundle output to chapter rows. */
export const chapterItemsFromCapture = (captured: unknown): JsonObject[] => {
  if (Array.isArray(captured)) {
    return captured.filter(
      (item): item is JsonObject => typeof item === "object" && item !== null,
    );
  }
  if (typeof captured === "object" && captured !== null) {
    const record = captured as { r?: unknown; items?: unknown; result?: { items?: unknown } };
    const nested = record.r ?? record.items ?? record.result?.items;
    if (Array.isArray(nested)) {
      return nested.filter(
        (item): item is JsonObject => typeof item === "object" && item !== null,
      );
    }
  }
  return [];
};

export interface ComixLatestChapter {
  readonly id: string;
  readonly chapNum: number;
  readonly publishedAt?: Date;
}

export interface ComixResolvedHid {
  readonly hid?: string;
  readonly slug?: string;
  readonly url?: string;
}

export const createComixFallback = (session: ComixSession) => ({
  async findChapters(
    titles: readonly string[],
    sourceManga: SourceManga,
  ): Promise<Chapter[]> {
    const { hid } = await this.resolveHid(titles);
    if (!hid) {return [];}
    return this.fetchChaptersByHid(hid, sourceManga);
  },

  async resolveHid(
    titles: readonly string[],
    scope?: { readonly maxTitles?: number; readonly pages?: number },
  ): Promise<ComixResolvedHid> {
    // Each search page is a full WebView capture, so callers that only need a
    // good-enough match (latest-chapter probes) can narrow the sweep; chapter
    // lists keep the wide default.
    const maxTitles = scope?.maxTitles ?? 6;
    const maxPages = scope?.pages ?? 2;
    const allItems: SearchItem[] = [];
    const seenHids = new Set<string>();
    let attemptedTitles = 0;
    for (const title of titles) {
      const query = title.trim();
      if (!query) {continue;}
      if (++attemptedTitles > maxTitles) {break;}
      for (let page = 1; page <= maxPages; page += 1) {
        const searchPage =
          `${COMIX_ORIGIN}/browse?page=${page}&keyword=${encodeURIComponent(query)}`;
        const searchPayload = await captureViaSiteBundle(
          session,
          searchPage,
          captureBootstrap(SEARCH_MATCHER),
        );
        const searchRoot = ((): { result?: { items?: SearchItem[] } } | null => {
          try {
            const decoded =
              typeof searchPayload === "string"
                ? (JSON.parse(searchPayload) as { result?: { items?: SearchItem[] } })
                : (searchPayload as { result?: { items?: SearchItem[] } } | null);
            return decoded ?? null;
          } catch {
            return null;
          }
        })();
        const items = Array.isArray(searchRoot?.result?.items)
          ? (searchRoot.result.items as SearchItem[])
          : [];
        for (const item of items) {
          const hid = asString(item.hid) || asString(item.hash_id);
          if (hid && !seenHids.has(hid)) {
            seenHids.add(hid);
            allItems.push(item);
          } else if (!hid) {
            allItems.push(item);
          }
        }
        // Every search page is a WebView capture (~seconds each), so stop
        // sweeping aliases as soon as a title matches exactly — the fuzzy
        // pass over everything only runs when no exact hit exists.
        const exact = pickComixMatch(allItems, titles, true);
        if (exact) {
          const exactHid = asString(exact.hid) || asString(exact.hash_id);
          if (exactHid) {
            return {
              hid: exactHid,
              slug: asString(exact.slug),
              url: asString(exact.url),
            };
          }
        }
      }
    }
    const matched = pickComixMatch(allItems, titles);
    if (!matched) {return {};}
    const hid = asString(matched.hid) || asString(matched.hash_id);
    const slug = asString(matched.slug);
    const url = asString(matched.url);
    return { hid, slug, url };
  },

  async fetchChaptersByHid(
    hid: string,
    sourceManga: SourceManga,
  ): Promise<Chapter[]> {
    const trimmed = hid.trim();
    if (!trimmed) {return [];}
    // hid may already contain slug (hid-slug) or be pure hid; normalize to hid
    const pureHid = trimmed.split("-")[0] ?? trimmed;
    // Try to reuse slug/url if we have it cached, but fallback to hid-only path
    const mangaPath = `/title/${pureHid}`;
    const captured = await captureViaSiteBundle(
      session,
      `${COMIX_ORIGIN}${mangaPath}`,
      CHAPTERS_BOOTSTRAP,
    );
    // captureViaSiteBundle already unwraps `{ r: payload }` → payload.
    // CHAPTERS_BOOTSTRAP finishes with an array of chapter items, so treat a
    // bare array as the list. Re-reading `.r` here emptied every capture
    // (WebView logged "chapter batch:20:…" then getChapters cached mangadex:0).
    const rawItems = chapterItemsFromCapture(captured);
    if (rawItems.length === 0) {return [];}
    const mapped = toSyncComixChapters(rawItems, sourceManga);
    if (mapped.length === 0) {return [];}
    console.log(
      `[manifold] comix fallback:${sourceManga.mangaId}:${mapped.length}`,
    );
    return mapped;
  },

  async latestChapterByHid(hid: string): Promise<ComixLatestChapter | undefined> {
    const trimmed = hid.trim();
    const pureHid = trimmed.split("-")[0] ?? trimmed;
    if (!pureHid) {return undefined;}
    const payloadText = await captureViaSiteBundle(
      session,
      `${COMIX_ORIGIN}/title/${pureHid}`,
      captureBootstrap(LATEST_MATCHER),
    );
    let items: JsonObject[] = [];
    try {
      const decoded =
        typeof payloadText === "string"
          ? (JSON.parse(payloadText) as { result?: { items?: unknown[] } })
          : (payloadText as { result?: { items?: unknown[] } } | null);
      items = Array.isArray(decoded?.result?.items)
        ? (decoded.result.items as JsonObject[])
        : [];
    } catch {
      return undefined;
    }
    if (items.length === 0) {return undefined;}
    // The site lists newest first; sort defensively by timestamp when the
    // payloads carry one.
    const stampOf = (item: JsonObject): number => {
      for (const key of ["created_at", "createdAt", "published_at", "publishedAt"]) {
        const date = asDateValue(item[key]);
        if (date) {return date.valueOf();}
      }
      return 0;
    };
    const newest = [...items].sort((a, b) => stampOf(b) - stampOf(a))[0];
    if (!newest) {return undefined;}
    const id = asText(newest.id) || asText(newest.chapter_id) || asText(newest.hid);
    if (!id) {return undefined;}
    return {
      id,
      chapNum: numberLike(newest.number) ?? numberLike(newest.chapter) ?? 0,
      ...(stampOf(newest) > 0 ? { publishedAt: new Date(stampOf(newest)) } : {}),
    };
  },

  async detailsByHid(mangaId: string): Promise<SourceManga> {
    const hid = mangaId.split("-")[0] ?? mangaId;
    if (!hid) {throw new Error(`Invalid Comix manga id: ${mangaId}`);}
    const html = await requestHtml(session, `${COMIX_ORIGIN}/title/${hid}`);
    const manga = detailMangaFromHtml(html);
    if (!manga) {throw new Error(`Comix: could not find detail data for ${mangaId}`);}
    return comixSourceManga(mangaId, manga);
  },

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const raw = rawComixChapterId(chapter.chapterId);
    const chapterUrl =
      chapter.additionalInfo?.["Comix chapter URL"] ??
      `${COMIX_ORIGIN}/chapter/${raw}`;
    const path = chapterUrl.startsWith(COMIX_ORIGIN)
      ? chapterUrl.slice(COMIX_ORIGIN.length)
      : chapterUrl;

    const payloadText = await captureViaSiteBundle(
      session,
      `${COMIX_ORIGIN}${path}`,
      captureBootstrap(PAGES_MATCHER),
    );
    if (typeof payloadText !== "string" || payloadText.length === 0) {
      throw new Error(`Comix returned no readable pages for chapter ${raw}`);
    }

    try {
      return toChapterDetails(JSON.parse(payloadText) as JsonObject, chapter);
    } catch {
      const execution = await Application.executeInWebView({
        source: {
          html: "<html><head></head><body></body></html>",
          baseUrl: chapterUrl,
          loadCSS: false,
          loadImages: true,
        },
        inject: pagesInspectorScript(chapterUrl),
        storage: { cookies: [...session.cookies()] },
      });
      session.setCookies(execution.storage.cookies);
      const pages = pagesFromResult(execution.result);
      if (pages.length === 0) {
        throw new Error(`Comix did not expose readable pages for chapter ${raw}`);
      }
      return {
        id: chapter.chapterId,
        mangaId: chapter.sourceManga.mangaId,
        type: "images",
        pages,
      };
    }
  },
});

const pagesFromResult = (result: unknown): string[] => {
  if (!Array.isArray(result)) {return [];}
  return result
    .map((item) => (typeof item === "object" && item !== null
      ? String((item as Record<string, unknown>).src ?? "")
      : String(item)))
    .filter((url) => url.startsWith("http"));
};

function pagesInspectorScript(_chapterUrl: string): string {
  return `(function(){
    var urls=[];
    document.querySelectorAll("img").forEach(function(img){
      var src=img.currentSrc||img.src||"";
      if(src&&/\\/(?:i|si|images?)\\//i.test(src)&&!/poster|logo|avatar|favicon/i.test(src))urls.push(src);
    });
    return urls;
  })()`;
}
