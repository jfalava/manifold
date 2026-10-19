/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { Data, Schema } from "effect";
import { manifoldUserAgent, type JsonValue } from "@manifold/json";
import { isChallengeText, type BrowserView } from "@/browser-view";
import { cliError, platformFetch, runHost, sleepPromise } from "@/effect-kit";
import { providerIdOf } from "@/registry-titles";

export const MANGANATO_ORIGIN = "https://www.manganato.gg";

const SearchPage = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, title: Schema.NonEmptyString })),
  next: Schema.NullOr(Schema.String),
});
const Details = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  authors: Schema.Array(Schema.String),
});
export type ManganatoDetails = Schema.Schema.Type<typeof Details>;
export interface ManganatoIdentity {
  readonly titles: readonly string[];
  readonly authors: readonly string[];
}

export class ManganatoBlockedError extends Data.TaggedError("ManganatoBlockedError")<{
  readonly message: string;
}> {}

// Keep all letters/numbers, including edition suffixes. Only spacing, punctuation and accents vary.
const titleKey = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

const authorKey = (value: string): string =>
  value
    .replace(/\([^)]*\)/g, "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");

export const hasManganatoTitle = (titles: readonly string[], names: readonly string[]): boolean => {
  const keys = new Set(titles.map(titleKey).filter(Boolean));
  return names.some((name) => keys.has(titleKey(name)));
};

export const hasManganatoAuthor = (
  expected: readonly string[],
  actual: readonly string[],
): boolean => {
  const keys = new Set(expected.map(authorKey).filter((key) => key && key !== "unknown"));
  return actual.some((author) => keys.has(authorKey(author)));
};

export const selectManganatoCandidate = (
  identity: ManganatoIdentity,
  candidates: readonly ManganatoDetails[],
): ManganatoDetails | undefined => {
  const plausible = [
    ...new Map(
      candidates
        .filter((candidate) =>
          hasManganatoTitle(identity.titles, [candidate.title, ...candidate.aliases]),
        )
        .map((candidate) => [candidate.id, candidate]),
    ).values(),
  ];
  // Unknown/mismatched credits do not eliminate a duplicate title. Never pick by chapter count.
  return plausible.length === 1 && hasManganatoAuthor(identity.authors, plausible[0]!.authors)
    ? plausible[0]
    : undefined;
};

/** MangaNato search ORs words. A long single word reduces unrelated pages; search every chosen alias. */
export const manganatoSearchTerms = (titles: readonly string[]): readonly string[] => [
  ...new Set(
    titles
      .slice(0, 3)
      .map(
        (title) =>
          (title.match(/[\p{L}\p{N}]+/gu) ?? [title]).sort((a, b) => b.length - a.length)[0]!,
      ),
  ),
];

const MangaDexIdentity = Schema.Struct({
  data: Schema.Struct({
    attributes: Schema.Struct({
      title: Schema.Record(Schema.String, Schema.String),
      altTitles: Schema.Array(Schema.Record(Schema.String, Schema.String)),
    }),
    relationships: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        attributes: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
      }),
    ),
  }),
});

export const loadManganatoIdentity = async (
  row: {
    readonly title: string;
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  onProgress: (message: string) => void,
): Promise<ManganatoIdentity> => {
  const id = providerIdOf(row, "mangadex");
  if (!id) {
    onProgress("No MangaDex author evidence; title-only candidates will need review");
    return { titles: [row.title], authors: [] };
  }
  onProgress("Loading MangaDex aliases and author/artist credits (20s timeout)");
  try {
    const response = await platformFetch(
      `https://api.mangadex.org/manga/${encodeURIComponent(id)}?includes[]=author&includes[]=artist`,
      {
        headers: { "user-agent": manifoldUserAgent("cli") },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw cliError(`MangaDex HTTP ${response.status}`);
    }
    const { data } = await runHost(
      Schema.decodeUnknownEffect(MangaDexIdentity)(await response.json()),
    );
    const aliases = [
      ...Object.values(data.attributes.title),
      ...data.attributes.altTitles.flatMap((titles) => Object.values(titles)),
    ];
    // English/Latin aliases first, so a native title does not consume the small search budget.
    aliases.sort(
      (a, b) =>
        Number(/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(a)) -
        Number(/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(b)),
    );
    const seen = new Set<string>();
    const titles = [row.title, ...aliases].filter((title) => {
      const key = titleKey(title);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return {
      titles,
      authors: data.relationships.flatMap((link) =>
        ["author", "artist"].includes(link.type) && link.attributes?.name
          ? [link.attributes.name]
          : [],
      ),
    };
  } catch (error) {
    onProgress(
      `MangaDex metadata unavailable: ${error instanceof Error ? error.message : String(error)}; no automatic title-only links`,
    );
    return { titles: [row.title], authors: [] };
  }
};

/** Catalog reads run inside an already-cleared Chrome tab; cookies never leave Chrome. */
export const createManganatoClient = (options: {
  readonly view: BrowserView;
  readonly delay: number;
  readonly maxPages: number;
  readonly onProgress?: (message: string) => void;
}) => {
  let requested = false;
  const searches = new Map<string, readonly ManganatoDetails[]>();
  const details = new Map<string, ManganatoDetails>();
  const read = async <A>(
    path: string,
    parser: string,
    schema: Schema.ConstraintDecoder<A>,
  ): Promise<A> => {
    if (requested) {
      await sleepPromise(options.delay);
    }
    requested = true;
    options.onProgress?.(path);
    const wire = await options.view.evaluate<JsonValue>(`(async () => {
      if (location.origin !== ${JSON.stringify(MANGANATO_ORIGIN)}) throw new Error('Open www.manganato.gg in this tab first');
      const response = await fetch(${JSON.stringify(path)}, {credentials:'same-origin', redirect:'error', signal:AbortSignal.timeout(20000)});
      const text = await response.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const challenged = response.headers.get('cf-mitigated') === 'challenge' || /^\\s*just a moment\\b/i.test(doc.title) || !!doc.querySelector('#challenge-running, #challenge-form');
      return {status:response.status, challenged, data:response.status === 200 && !challenged ? (() => {${parser}})() : null};
    })()`);
    const response = await runHost(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          status: Schema.Finite,
          challenged: Schema.Boolean,
          data: Schema.Unknown,
        }),
      )(wire),
    );
    if (response.challenged || response.status === 403 || response.status === 429) {
      throw new ManganatoBlockedError({
        message: `MangaNato ${path}: ${response.challenged ? "Cloudflare challenge; solve it in regular Chrome" : `HTTP ${response.status}; rerun later`}. Stopping without retrying.`,
      });
    }
    if (response.status !== 200) {
      throw cliError(`MangaNato ${path}: HTTP ${response.status}`);
    }
    return runHost(Schema.decodeUnknownEffect(schema)(response.data));
  };
  const getDetails = async (id: string): Promise<ManganatoDetails> => {
    const cached = details.get(id);
    if (cached) {
      return cached;
    }
    const result = await read(
      `/manga/${encodeURIComponent(id)}`,
      `
      const authorRow = [...doc.querySelectorAll('.info-wrap > div')].find(e => /Author\\(s\\):/i.test(e.textContent));
      return {id:${JSON.stringify(id)}, title:doc.querySelector('h1')?.textContent?.trim() ?? '',
        aliases:(doc.querySelector('.story-alternative')?.textContent ?? '').replace(/^Alternative\\s*:?/i, '').split(';').map(s => s.trim()).filter(Boolean),
        authors:(authorRow?.textContent ?? '').replace(/Author\\(s\\):/i, '').split(/[,;\\/]/).map(s => s.trim()).filter(Boolean)};
    `,
      Details,
    );
    details.set(id, result);
    return result;
  };
  return {
    details: getDetails,
    search: async (query: string): Promise<readonly ManganatoDetails[]> => {
      const cached = searches.get(query);
      if (cached) {
        return cached;
      }
      let path = `/search/story/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, "_"))}?page=1`;
      const visited = new Set<string>();
      const fingerprints = new Set<string>();
      const found = new Map<string, { readonly id: string; readonly title: string }>();
      for (let page = 1; ; page++) {
        if (page > options.maxPages || visited.has(path)) {
          throw cliError(
            `Incomplete MangaNato search for ${query}; page limit or repeated pagination`,
          );
        }
        visited.add(path);
        const result = await read(
          path,
          `
          const items = [...doc.querySelectorAll('div.story_item')].map(e => {
            const a = e.querySelector('.story_name a') ?? e.querySelector('a');
            const url = new URL(a?.getAttribute('href') ?? '', ${JSON.stringify(MANGANATO_ORIGIN)});
            return {id:url.origin === ${JSON.stringify(MANGANATO_ORIGIN)} && /^\\/manga\\/[^/]+\\/?$/.test(url.pathname) ? url.pathname.split('/')[2] : '', title:e.querySelector('.story_name')?.textContent?.trim() ?? ''};
          });
          const next = [...doc.querySelectorAll('.panel_page_number a')].find(a => /^next\\b/i.test(a.textContent.trim()) && a.getAttribute('href'));
          return {title:doc.title, items, next:next?.getAttribute('href') ?? null};
        `,
          SearchPage,
        );
        if (!/^Search Results for /i.test(result.title) || isChallengeText(result.title)) {
          throw cliError(`Unexpected MangaNato search page for ${query}`);
        }
        const fingerprint = result.items
          .map((item) => item.id)
          .sort()
          .join("|");
        if (
          (result.items.length && fingerprints.has(fingerprint)) ||
          (!result.items.length && result.next)
        ) {
          throw cliError(`Incomplete MangaNato search for ${query}; repeated/empty page`);
        }
        fingerprints.add(fingerprint);
        for (const item of result.items) {
          found.set(item.id, item);
        }
        if (!result.next) {
          break;
        }
        const next = new URL(result.next, `${MANGANATO_ORIGIN}${path}`);
        const current = new URL(path, MANGANATO_ORIGIN);
        if (
          next.origin !== MANGANATO_ORIGIN ||
          next.pathname !== current.pathname ||
          Number(next.searchParams.get("page")) <= Number(current.searchParams.get("page")) ||
          !Number.isSafeInteger(Number(next.searchParams.get("page")))
        ) {
          throw cliError(`Invalid MangaNato pagination for ${query}`);
        }
        path = next.pathname + next.search;
      }
      // Fetch only title-plausible details in the caller, not every broad search hit.
      const results = [...found.values()].map((item) => ({ ...item, aliases: [], authors: [] }));
      searches.set(query, results);
      return results;
    },
  };
};
