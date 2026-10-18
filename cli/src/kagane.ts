/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { Data, Effect, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { manifoldUserAgent, type JsonObject, type JsonValue } from "@manifold/json";
import { cliError, epochMillisNow, platformFetch, runHost, sleepPromise } from "@/effect-kit";
import type { BrowserView } from "@/browser-view";

export const KAGANE_ORIGIN = "https://kagane.org";

export const kaganeProfileDir = (home = homedir()): string =>
  join(home, ".manifold", "kagane-chrome");

const SearchBook = Schema.Struct({
  series_id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  source_id: Schema.optional(Schema.NullOr(Schema.String)),
  current_books: Schema.optional(Schema.Finite),
  format: Schema.optional(Schema.NullOr(Schema.String)),
  alternate_titles: Schema.optional(Schema.Array(Schema.String)),
});
export type KaganeBook = Schema.Schema.Type<typeof SearchBook>;
const SearchPage = Schema.Struct({ content: Schema.Array(SearchBook), last: Schema.Boolean });
const Sources = Schema.Struct({
  sources: Schema.Array(Schema.Struct({ source_id: Schema.NonEmptyString, title: Schema.String })),
});
const Details = Schema.Struct({
  title: Schema.NonEmptyString,
  translated_language: Schema.optional(Schema.NullOr(Schema.String)),
  source_id: Schema.optional(Schema.NullOr(Schema.String)),
  format: Schema.optional(Schema.NullOr(Schema.String)),
  edition_info: Schema.optional(Schema.NullOr(Schema.String)),
  current_books: Schema.optional(Schema.Finite),
  series_alternate_titles: Schema.optional(Schema.Array(Schema.Struct({ title: Schema.String }))),
  series_links: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String }))),
});
export type KaganeDetails = Schema.Schema.Type<typeof Details>;

export class KaganeCooldownError extends Data.TaggedError("KaganeCooldownError")<{
  readonly message: string;
}> {}

export class KaganeChallengeError extends Data.TaggedError("KaganeChallengeError")<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "Kagane Cloudflare challenge. Open kagane.org in a local Chrome debug session, solve the challenge, then rerun with --chrome-cdp-url <ws://...>. No account/API key is required.",
    });
  }
}

/** Only punctuation/case equivalence, never fuzzy stems or stripped edition suffixes. */
export const normalizeKaganeTitle = (title: string): string =>
  title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const hasExactKaganeTitle = (
  titles: readonly string[],
  names: readonly string[],
): boolean => {
  const normalized = new Set(titles.map(normalizeKaganeTitle).filter(Boolean));
  return names.some((name) => normalized.has(normalizeKaganeTitle(name)));
};

/** Catalog-only client: no reader tokens, chapter downloads, or account credentials. */
export const createKaganeClient = (options: {
  readonly delay: number;
  readonly view?: BrowserView;
  readonly maxPages?: number;
  readonly onRetry?: (message: string) => void;
}) => {
  let requested = false;
  const maxPages = options.maxPages ?? 200;
  const detailCache = new Map<string, KaganeDetails>();
  const searchCache = new Map<string, readonly KaganeBook[]>();
  const send = async (path: string, body?: JsonObject) => {
    if (requested) {
      await sleepPromise(options.delay);
    }
    requested = true;
    const method = body === undefined ? "GET" : "POST";
    if (options.view) {
      // Execute in Chrome itself; replaying cf_clearance through fetch is unreliable.
      const wire = await options.view.evaluate<JsonValue>(`(async () => {
        if (location.origin !== ${JSON.stringify(KAGANE_ORIGIN)}) throw new Error('Open kagane.org in this tab first');
        const response = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(method)}, headers: {'content-type':'application/json'},
          body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))},
          credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000)
        });
        return {status:response.status, challenged:response.headers.get('cf-mitigated') === 'challenge', retryAfter:response.headers.get('retry-after'), text:await response.text()};
      })()`);
      return runHost(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Finite,
            challenged: Schema.Boolean,
            retryAfter: Schema.NullOr(Schema.String),
            text: Schema.String,
          }),
        )(wire),
      );
    }
    const response = await platformFetch(`${KAGANE_ORIGIN}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        origin: KAGANE_ORIGIN,
        referer: `${KAGANE_ORIGIN}/`,
        "user-agent": manifoldUserAgent("cli"),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    return {
      status: response.status,
      challenged: response.headers.get("cf-mitigated") === "challenge",
      retryAfter: response.headers.get("retry-after"),
      text: await response.text(),
    };
  };
  const request = async <A>(
    path: string,
    schema: Schema.ConstraintDecoder<A>,
    body?: JsonObject,
  ): Promise<A> => {
    // Catalog requests are read-only, including search POSTs. Never retry registry writes here.
    for (let attempt = 0; ; attempt++) {
      let response: Awaited<ReturnType<typeof send>>;
      try {
        response = await send(path, body);
      } catch (error) {
        if (
          attempt >= 3 ||
          !(error instanceof Error) ||
          (!/TypeError|TimeoutError|AbortError|Connection|Socket/.test(error.name) &&
            !/fetch failed|failed to (?:connect|fetch)|connection (?:closed|reset)|socket (?:closed|hang up)|timed out/i.test(
              error.message,
            ))
        ) {
          throw error;
        }
        const wait = 1000 * 2 ** attempt;
        options.onRetry?.(`${path}: ${error.name}; retry ${attempt + 1}/3 in ${wait}ms`);
        await sleepPromise(wait);
        continue;
      }
      if (
        response.challenged ||
        /<title>Just a moment|cf-chl-|challenge-platform/i.test(response.text)
      ) {
        throw new KaganeChallengeError();
      }
      if (response.status === 429 || [500, 502, 503, 504].includes(response.status)) {
        if (attempt >= 3) {
          if (response.status === 429) {
            throw new KaganeCooldownError({
              message: `Kagane ${path}: HTTP 429 after 3 retries; stopping to respect rate limiting`,
            });
          }
          throw cliError(`Kagane ${path}: HTTP ${response.status} after 3 retries`);
        }
        const raw = response.retryAfter;
        const seconds = raw === null ? NaN : Number(raw);
        const retryAfter =
          raw === null
            ? 0
            : Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(raw) - epochMillisNow();
        const wait = Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter : 0);
        // Do not retry earlier than requested when the server asks for a long cooldown.
        if (wait > 120_000) {
          throw new KaganeCooldownError({
            message: `Kagane ${path}: HTTP ${response.status}; Retry-After exceeds 120s, rerun later`,
          });
        }
        options.onRetry?.(`${path}: HTTP ${response.status}; retry ${attempt + 1}/3 in ${wait}ms`);
        await sleepPromise(wait);
        continue;
      }
      if (response.status !== 200) {
        throw cliError(`Kagane ${path}: HTTP ${response.status}`);
      }
      return runHost(
        Schema.decodeEffect(Schema.fromJsonString(schema))(response.text).pipe(
          Effect.mapError(() => cliError(`Kagane ${path}: unexpected response schema`)),
        ),
      );
    }
  };

  return {
    sources: () => request("/api/v2/sources/list", Sources, { source_types: null }),
    details: async (id: string) => {
      const cached = detailCache.get(id);
      if (cached) {
        return cached;
      }
      const details = await request(`/api/v2/series/${encodeURIComponent(id)}`, Details);
      detailCache.set(id, details);
      return details;
    },
    search: async (title: string, language: string, sourceIds: readonly string[] = []) => {
      const key = JSON.stringify([title, language, sourceIds]);
      const cached = searchCache.get(key);
      if (cached) {
        return cached;
      }
      const books = new Map<string, KaganeBook>();
      const pages = new Set<string>();
      // Never accept a unique match from a truncated result set. Preserve cooldown/challenge errors.
      for (let page = 0; page < maxPages; page++) {
        const result = await request(`/api/v2/search/series?page=${page}&size=35`, SearchPage, {
          title,
          content_lang: [language],
          content_rating: ["Safe", "Suggestive", "Erotica", "Pornographic"],
          age_rating: ["Safe", "FifteenPlus", "EighteenPlus"],
          ...(sourceIds.length > 0 && { source_id: [...sourceIds] }),
        });
        const fingerprint = JSON.stringify(result.content.map((book) => book.series_id));
        if (pages.has(fingerprint) && result.content.length > 0) {
          throw cliError("Kagane search pagination did not advance");
        }
        pages.add(fingerprint);
        for (const book of result.content) {
          books.set(book.series_id, book);
        }
        if (result.last) {
          const found = [...books.values()];
          searchCache.set(key, found);
          return found;
        }
      }
      throw cliError(
        `Kagane search exceeded ${maxPages} pages; no link selected. Narrow --source-priority or increase --max-pages.`,
      );
    },
  };
};

type ProviderIdentity = {
  readonly provider: string;
  readonly externalId: string;
};

/** Only recognize work URLs on the provider's own host, never labels or embedded URLs. */
const identityFromUrl = (value: string): ProviderIdentity | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    return undefined;
  }
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "manga" && /^[1-9]\d*$/.test(parts[1] ?? "")) {
    if (host === "anilist.co") {
      return { provider: "anilist", externalId: parts[1]! };
    }
    if (host === "myanimelist.net") {
      return { provider: "mal", externalId: parts[1]! };
    }
  }
  if (
    host === "mangadex.org" &&
    parts[0] === "title" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(parts[1] ?? "")
  ) {
    return { provider: "mangadex", externalId: parts[1]!.toLowerCase() };
  }
  return undefined;
};

export type KaganeCandidate = {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly books: number;
  readonly identities: readonly ProviderIdentity[];
  readonly matchedIds: readonly string[];
  readonly reasons: readonly string[];
};

export const verifyKaganeCandidate = (
  book: KaganeBook,
  details: KaganeDetails,
  row: { readonly providers: readonly ProviderIdentity[] },
  titles: readonly string[],
  language: string,
  source: string | undefined,
): KaganeCandidate => {
  const identities = (details.series_links ?? []).flatMap((link) => {
    const identity = identityFromUrl(link.url);
    return identity ? [identity] : [];
  });
  const matchedIds: string[] = [];
  const reasons: string[] = [];
  for (const provider of ["anilist", "mal", "mangadex"]) {
    const ids = new Set(
      identities.filter((id) => id.provider === provider).map((id) => id.externalId),
    );
    const expected = row.providers.find((id) => id.provider === provider)?.externalId.toLowerCase();
    if (ids.size > 1 || (expected && [...ids].some((id) => id !== expected))) {
      reasons.push(`contradictory ${provider} ID`);
    }
    if (expected && ids.has(expected)) {
      matchedIds.push(provider);
    }
  }
  if (
    !matchedIds.length &&
    !hasExactKaganeTitle(titles, [
      details.title,
      ...(details.series_alternate_titles ?? []).map((alias) => alias.title),
    ])
  ) {
    reasons.push("detail title mismatch");
  }
  if (details.translated_language !== language) {
    reasons.push(`language=${details.translated_language ?? "missing"}`);
  }
  if (!source || details.source_id !== book.source_id) {
    reasons.push("unknown or inconsistent source");
  }
  if (details.edition_info?.trim()) {
    reasons.push(`edition=${details.edition_info}`);
  }
  const books = details.current_books ?? book.current_books ?? 0;
  if (books <= 0) {
    reasons.push("no available books");
  }
  if (book.format && details.format && book.format.toLowerCase() !== details.format.toLowerCase()) {
    reasons.push("format mismatch");
  }
  return {
    id: book.series_id,
    title: details.title,
    source: source ?? "unknown",
    books,
    identities,
    matchedIds,
    reasons,
  };
};

/** Source preference is only a tie-break between externally verified identities. */
export const selectKaganeCandidate = (
  candidates: readonly KaganeCandidate[],
  priority: readonly string[],
): KaganeCandidate | undefined => {
  const compatible = candidates.filter((candidate) => candidate.reasons.length === 0);
  const verified = compatible.filter((candidate) => candidate.matchedIds.length > 0);
  if (verified.length === 0) {
    // A rejected competing title is not proof that the remaining title is the right work.
    return candidates.length === 1 ? compatible[0] : undefined;
  }
  for (const provider of ["anilist", "mal", "mangadex"]) {
    const ids = new Set(
      verified.flatMap((candidate) =>
        candidate.identities.filter((id) => id.provider === provider).map((id) => id.externalId),
      ),
    );
    if (ids.size > 1) {
      return undefined;
    }
  }
  if (verified.length === 1) {
    return verified[0];
  }
  for (const source of priority) {
    const preferred = verified.filter(
      (candidate) => candidate.source.toLowerCase() === source.toLowerCase(),
    );
    if (preferred.length > 0) {
      return preferred.length === 1 ? preferred[0] : undefined;
    }
  }
  return undefined;
};
