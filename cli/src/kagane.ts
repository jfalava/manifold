/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { Data, Effect, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { manifoldUserAgent, type JsonObject, type JsonValue } from "@manifold/json";
import { cliError, fromPromise, platformFetch, runHost, sleepPromise } from "@/effect-kit";
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
  series_alternate_titles: Schema.optional(Schema.Array(Schema.Struct({ title: Schema.String }))),
});
export type KaganeDetails = Schema.Schema.Type<typeof Details>;

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
}) => {
  let requested = false;
  const request = async <A>(
    path: string,
    schema: Schema.ConstraintDecoder<A>,
    body?: JsonObject,
  ): Promise<A> => {
    if (requested) {
      await sleepPromise(options.delay);
    }
    requested = true;
    const method = body === undefined ? "GET" : "POST";
    let status: number;
    let challenged: boolean;
    let responseText: string;
    if (options.view) {
      // Execute in Chrome itself; replaying cf_clearance through fetch is unreliable.
      const wire = await options.view.evaluate<JsonValue>(`(async () => {
        if (location.origin !== ${JSON.stringify(KAGANE_ORIGIN)}) throw new Error('Open kagane.org in this tab first');
        const response = await fetch(${JSON.stringify(path)}, {
          method: ${JSON.stringify(method)}, headers: {'content-type':'application/json'},
          body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))},
          credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000)
        });
        return {status:response.status, challenged:response.headers.get('cf-mitigated') === 'challenge', text:await response.text()};
      })()`);
      const result = await runHost(
        Schema.decodeUnknownEffect(
          Schema.Struct({ status: Schema.Finite, challenged: Schema.Boolean, text: Schema.String }),
        )(wire),
      );
      status = result.status;
      challenged = result.challenged;
      responseText = result.text;
    } else {
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
      status = response.status;
      challenged = response.headers.get("cf-mitigated") === "challenge";
      responseText = await response.text();
    }
    if (challenged || /<title>Just a moment|cf-chl-|challenge-platform/i.test(responseText)) {
      throw new KaganeChallengeError();
    }
    if (status !== 200) {
      throw cliError(`Kagane ${path}: HTTP ${status}`);
    }
    return runHost(
      Schema.decodeEffect(Schema.fromJsonString(schema))(responseText).pipe(
        Effect.mapError(() => cliError(`Kagane ${path}: unexpected response schema`)),
      ),
    );
  };

  return {
    sources: () => request("/api/v2/sources/list", Sources, { source_types: null }),
    details: (id: string) => request(`/api/v2/series/${encodeURIComponent(id)}`, Details),
    search: (title: string, language: string) =>
      runHost(
        Effect.gen(function* () {
          const books = new Map<string, KaganeBook>();
          const pages = new Set<string>();
          // Never accept a unique match from a truncated result set.
          for (let page = 0; page < 20; page++) {
            const result = yield* fromPromise(() =>
              request(`/api/v2/search/series?page=${page}&size=35`, SearchPage, {
                title,
                content_lang: [language],
                content_rating: ["Safe", "Suggestive", "Erotica", "Pornographic"],
                age_rating: ["Safe", "FifteenPlus", "EighteenPlus"],
              }),
            );
            const fingerprint = JSON.stringify(result.content.map((book) => book.series_id));
            if (pages.has(fingerprint) && !result.last) {
              return yield* cliError("Kagane search pagination did not advance");
            }
            pages.add(fingerprint);
            for (const book of result.content) {
              books.set(book.series_id, book);
            }
            if (result.last) {
              return [...books.values()];
            }
          }
          return yield* cliError("Kagane search exceeded 20 pages; no link selected");
        }),
      ),
  };
};
