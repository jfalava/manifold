/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { Data, Effect, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { manifoldUserAgent, type JsonObject, type JsonValue } from "@manifold/json";
import { cliError, epochMillisNow, platformFetch, runHost, sleepPromise } from "@/effect-kit";
import type { BrowserView } from "@/browser-view";
import { chapterCoverage, mostCovered, type ChapterCoverage } from "@/chapter-coverage";
import { registryCatalog, RegistryPageBudgetError } from "@/registry-catalog";

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
const SearchPage = Schema.Struct({
  content: Schema.Array(SearchBook),
  last: Schema.Boolean,
  total_pages: Schema.optional(Schema.Finite),
});
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

const ChapterIndex = Schema.Struct({
  count: Schema.Int,
  fields: Schema.Array(Schema.String),
  books: Schema.Array(Schema.Array(Schema.Unknown)),
});
const ChapterPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      book_id: Schema.NonEmptyString,
      series_id: Schema.optional(Schema.NullOr(Schema.String)),
      chapter_no: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
      volume_no: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
    }),
  ),
  next_cursor: Schema.NullOr(Schema.String),
});

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
  readonly onProgress?: (message: string) => void;
  readonly catalog?: readonly JsonObject[];
  readonly onCache?: (record: JsonObject) => void;
  readonly onBlocked?: (error: KaganeChallengeError) => Promise<void>;
}) => {
  let requested = false;
  const maxPages = options.maxPages ?? 200;
  const catalog = registryCatalog({ ...options, origin: KAGANE_ORIGIN });
  const detailCache = new Map<string, KaganeDetails>();
  const coverageCache = new Map<string, ChapterCoverage>();
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
    description = path,
    validate?: (result: A) => void,
  ): Promise<A> => {
    const key = JSON.stringify([path, body ?? null]);
    const decode = (text: string) =>
      runHost(
        Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.mapError(() => cliError(`Kagane ${path}: unexpected response schema`)),
        ),
      );
    const cached = catalog.read(key);
    if (cached !== undefined) {
      try {
        const result = await decode(cached);
        validate?.(result);
        options.onProgress?.(`Cached ${description}`);
        return result;
      } catch {
        // Reports are untrusted input; invalid cached data is fetched again.
        catalog.forget(key);
      }
    }
    // Catalog requests are read-only, including search POSTs. Never retry registry writes here.
    for (let attempt = 0; ; attempt++) {
      let response: Awaited<ReturnType<typeof send>>;
      try {
        options.onProgress?.(`${description}${attempt ? `; attempt ${attempt + 1}/4` : ""}`);
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
        const error = new KaganeChallengeError();
        if (!options.view || !options.onBlocked) {
          throw error;
        }
        await options.onBlocked(error);
        attempt = -1;
        continue;
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
      const result = await decode(response.text);
      validate?.(result);
      catalog.remember(key, response.text);
      return result;
    }
  };

  return {
    sources: () => request("/api/v2/sources/list", Sources, { source_types: null }),
    coverage: async (id: string): Promise<ChapterCoverage> => {
      const cached = coverageCache.get(id);
      if (cached) {
        return cached;
      }
      const base = `/api/v2/series/${encodeURIComponent(id)}/books`;
      const index = await request(
        `${base}/index`,
        ChapterIndex,
        undefined,
        `${id} chapter index`,
        (result) => {
          const column = result.fields.indexOf("book_id");
          const expected = new Set(result.books.map((row) => row[column]));
          if (
            column < 0 ||
            result.count < 0 ||
            result.count !== result.books.length ||
            expected.size !== result.count ||
            [...expected].some((value) => !Schema.is(Schema.NonEmptyString)(value))
          ) {
            throw cliError(`Kagane ${id}: invalid chapter index`);
          }
        },
      );
      const column = index.fields.indexOf("book_id");
      const expected = new Set(index.books.map((row) => row[column]));
      const books: Schema.Schema.Type<typeof ChapterPage>["items"][number][] = [];
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let before: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const pageResult = await request(
          `${base}?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`,
          ChapterPage,
          undefined,
          `${id} chapter page ${page + 1}`,
          (result) => {
            const added = new Set<string>();
            for (const book of result.items) {
              if (
                seen.has(book.book_id) ||
                added.has(book.book_id) ||
                !expected.has(book.book_id) ||
                (book.series_id && book.series_id !== id)
              ) {
                catalog.forget(JSON.stringify([`${base}/index`, null]));
                throw cliError(`Kagane ${id}: chapter inventory disagrees with its index`);
              }
              added.add(book.book_id);
            }
            if (result.next_cursor === null) {
              if (seen.size + added.size !== expected.size) {
                throw cliError(`Kagane ${id}: incomplete chapter inventory`);
              }
            } else if (
              !result.next_cursor.trim() ||
              cursors.has(result.next_cursor) ||
              !result.items.length ||
              seen.size + added.size >= expected.size
            ) {
              throw cliError(`Kagane ${id}: chapter pagination did not advance`);
            }
          },
        );
        for (const book of pageResult.items) {
          seen.add(book.book_id);
          books.push(book);
        }
        if (pageResult.next_cursor === null) {
          const coverage = chapterCoverage(
            books.map((book) => ({ chapter: book.chapter_no, volume: book.volume_no })),
          );
          coverageCache.set(id, coverage);
          return coverage;
        }
        before = pageResult.next_cursor;
        cursors.add(before);
      }
      throw new RegistryPageBudgetError(
        `Kagane ${id}: chapter inventory exceeded ${maxPages} pages`,
      );
    },
    details: async (id: string) => {
      const cached = detailCache.get(id);
      if (cached) {
        return cached;
      }
      const details = await request(`/api/v2/series/${encodeURIComponent(id)}`, Details);
      detailCache.set(id, details);
      return details;
    },
    search: async (
      title: string,
      language: string,
      sourceIds: readonly string[] = [],
      onCandidate?: (book: KaganeBook) => void,
    ) => {
      const key = JSON.stringify([title, language, sourceIds]);
      const cached = searchCache.get(key);
      if (cached) {
        cached.forEach((book) => onCandidate?.(book));
        return cached;
      }
      const books = new Map<string, KaganeBook>();
      const pages = new Set<string>();
      let totalPages: number | undefined;
      // Never accept a unique match from a truncated result set. Preserve cooldown/challenge errors.
      for (let page = 0; page < maxPages; page++) {
        const pageResult = await request(
          `/api/v2/search/series?page=${page}&size=35`,
          SearchPage,
          {
            title,
            content_lang: [language],
            // Unlike MangaDex, Kagane includes all ratings when rating filters are omitted.
            ...(sourceIds.length > 0 && { source_id: [...sourceIds] }),
          },
          `Search "${title}" page ${page + 1}/${totalPages ?? "?"} (cap ${maxPages})`,
          (result) => {
            if (
              pages.has(JSON.stringify(result.content.map((book) => book.series_id))) &&
              result.content.length > 0
            ) {
              throw cliError("Kagane search pagination did not advance");
            }
          },
        );
        totalPages = pageResult.total_pages;
        const fingerprint = JSON.stringify(pageResult.content.map((book) => book.series_id));
        pages.add(fingerprint);
        for (const book of pageResult.content) {
          books.set(book.series_id, book);
          onCandidate?.(book);
        }
        if (pageResult.last) {
          const found = [...books.values()];
          searchCache.set(key, found);
          return found;
        }
      }
      throw new RegistryPageBudgetError(
        `Kagane search exceeded ${maxPages} pages; no link selected`,
      );
    },
  };
};

export type ProviderIdentity = {
  readonly provider: string;
  readonly externalId: string;
};

/** Only recognize work URLs on the provider's own host, never labels or embedded URLs. */
export const identityFromUrl = (value: string): ProviderIdentity | undefined => {
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
  readonly coverage?: ChapterCoverage;
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
  if (source?.trim().toLowerCase() === "mangadex") {
    reasons.push("MangaDex content source excluded");
  }
  if (details.edition_info?.trim()) {
    reasons.push(`edition=${details.edition_info}`);
  }
  const books = details.current_books ?? book.current_books ?? 0;
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

/** Coverage ranks proven editions; source preference only breaks equal-coverage ties. */
export const selectKaganeCandidate = (
  candidates: readonly KaganeCandidate[],
  priority: readonly string[],
): KaganeCandidate | undefined => {
  const compatible = candidates.filter(
    (candidate) =>
      candidate.reasons.length === 0 &&
      !(candidate.coverage?.unit === "chapters" && candidate.coverage.count === 0),
  );
  const verified = compatible.filter((candidate) => candidate.matchedIds.length > 0);
  if (verified.length === 0) {
    // A rejected competing title is not proof that the remaining title is the right work.
    const only = candidates.length === 1 ? compatible[0] : undefined;
    return only?.coverage && only.coverage.unit !== "unknown" && only.coverage.count > 0
      ? only
      : undefined;
  }
  if (
    verified.some(
      (candidate) =>
        !candidate.coverage ||
        candidate.coverage.unit === "unknown" ||
        candidate.coverage.count === 0,
    )
  ) {
    return undefined;
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
  const largest = mostCovered(verified);
  if (largest.length === 1) {
    return largest[0];
  }
  for (const source of priority) {
    const preferred = largest.filter(
      (candidate) => candidate.source.toLowerCase() === source.toLowerCase(),
    );
    if (preferred.length > 0) {
      return preferred.length === 1 ? preferred[0] : undefined;
    }
  }
  return undefined;
};
