import * as Effect from "effect/Effect";
import { Schema } from "effect";
import {
  arrayField,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  numberField,
  objectField,
  stringField,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import {
  canonicalId,
  type CanonicalEntry,
  type CanonicalMetadata,
  type CanonicalSearchOptions,
  type CanonicalSearchResult,
  type CanonicalSearchSource,
  type CanonicalSourceError,
} from "./index";

export const ANILIST_GRAPHQL_ENDPOINT = "https://graphql.anilist.co";
export const MYANIMELIST_MANGA_ENDPOINT = "https://api.myanimelist.net/v2/manga";

export type CanonicalFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AniListSourceOptions {
  readonly fetcher?: CanonicalFetcher;
  readonly endpoint?: string;
  /** Override outbound User-Agent (defaults to manifold/canonical). */
  readonly userAgent?: string;
}

export interface MyAnimeListSourceOptions {
  readonly clientId: string;
  readonly fetcher?: CanonicalFetcher;
  readonly endpoint?: string;
  /** Override outbound User-Agent (defaults to manifold/canonical). */
  readonly userAgent?: string;
}

/** Parsed JSON body from a canonical provider HTTP response. */
export type CanonicalJson = JsonValue;

const JsonBodyString = Schema.fromJsonString(Schema.Unknown);
const jsonBodyString = (value: JsonValue): string =>
  Effect.runSync(Schema.encodeEffect(JsonBodyString)(value));

const platformFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
const defaultFetcher: CanonicalFetcher = (input, init) => platformFetch(input, init);

const stringValue = (value: JsonValue | undefined): string | undefined =>
  isString(value) && value.trim().length > 0 ? value.trim() : undefined;

const stringsFrom = (value: JsonValue | undefined): string[] =>
  isJsonArray(value)
    ? value.flatMap((item) => {
        const result = stringValue(item);
        return result === undefined ? [] : [result];
      })
    : [];

const mangaDexIdFromUrl = (value: JsonValue | undefined): string | undefined => {
  if (!isString(value)) {
    return undefined;
  }
  // Parse without global URL — Paperback's extension JSC sandbox does not
  // define it (`Can't find variable: URL`), and AniList enrichment runs this
  // on every library open when normalizing externalLinks.
  const trimmed = value.trim();
  const match =
    /^(?:https?:)?\/\/(?:www\.)?mangadex\.org\/title\/([0-9a-f]{8}-[0-9a-f-]{27})(?:\/|$)/i.exec(
      trimmed,
    );
  return match?.[1]?.toLowerCase();
};

const mangaDexExternalId = (value: JsonValue | undefined): string | undefined => {
  if (!isJsonArray(value)) {
    return undefined;
  }
  for (const link of value) {
    if (!isJsonObject(link)) {
      continue;
    }
    const id = mangaDexIdFromUrl(link.url);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
};

const uniqueStrings = (values: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
};

const sourceError = (
  provider: CanonicalSourceError["provider"],
  message: string,
  status?: number,
): CanonicalSourceError => ({
  _tag: "CanonicalSourceError",
  provider,
  message,
  ...(status !== undefined && { status }),
});

const isSourceError = (value: unknown): value is CanonicalSourceError =>
  isJsonObject(value) &&
  value._tag === "CanonicalSourceError" &&
  (value.provider === "anilist" || value.provider === "mal") &&
  isString(value.message);

const requestJson = (
  provider: CanonicalSourceError["provider"],
  fetcher: CanonicalFetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
): Effect.Effect<JsonObject, CanonicalSourceError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetcher(input, init),
      catch: (cause) =>
        sourceError(
          provider,
          cause instanceof Error ? cause.message : "Canonical provider request failed",
        ),
    });
    if (!response.ok) {
      const responseBody = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => sourceError(provider, "failed to read error body"),
      }).pipe(Effect.orElseSucceed(() => ""));
      const detail = responseBody.replace(/\s+/g, " ").trim().slice(0, 500);
      const headers = [
        response.headers.get("retry-after")
          ? `retry-after=${response.headers.get("retry-after")}`
          : undefined,
        response.headers.get("x-ratelimit-remaining")
          ? `x-ratelimit-remaining=${response.headers.get("x-ratelimit-remaining")}`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      const diagnostics = [...headers, detail ? `body=${detail}` : undefined]
        .filter((value): value is string => value !== undefined)
        .join("; ");
      const message = `Canonical provider returned HTTP ${response.status}${diagnostics ? `: ${diagnostics}` : ""}`;
      yield* Effect.logError(`[Canonical:${provider}] ${message}`);
      return yield* Effect.fail(sourceError(provider, message, response.status));
    }
    const body: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        sourceError(
          provider,
          cause instanceof Error ? cause.message : "Canonical provider JSON parse failed",
        ),
    });
    if (!isJsonObject(body)) {
      return yield* Effect.fail(
        sourceError(provider, "Canonical provider returned a non-object JSON body"),
      );
    }
    return body;
  });

const dateFromParts = (value: JsonValue | undefined): string | undefined => {
  if (value === undefined || !isJsonObject(value)) {
    return undefined;
  }
  const year = numberField(value, "year");
  const month = numberField(value, "month");
  const day = numberField(value, "day");
  if (year === undefined) {
    return undefined;
  }
  return [year, month, day]
    .filter((part): part is number => part !== undefined)
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
};

const metadata = (value: JsonObject): CanonicalMetadata => {
  const cover = objectField(value, "coverImage");
  const description = stringField(value, "description");
  const coverUrl =
    cover === undefined
      ? undefined
      : (stringField(cover, "extraLarge") ??
        stringField(cover, "large") ??
        stringField(cover, "medium"));
  const chapters = numberField(value, "chapters");
  const volumes = numberField(value, "volumes");
  const startDate = dateFromParts(value.startDate);
  const endDate = dateFromParts(value.endDate);
  const status = stringField(value, "status");
  return {
    ...(description !== undefined && { description }),
    ...(coverUrl !== undefined && { coverUrl }),
    ...(chapters !== undefined && { chapters }),
    ...(volumes !== undefined && { volumes }),
    ...(startDate !== undefined && { startDate }),
    ...(endDate !== undefined && { endDate }),
    ...(status !== undefined && { status }),
  };
};

const titleValues = (value: JsonValue | undefined): string[] => {
  if (value === undefined || !isJsonObject(value)) {
    return [];
  }
  return [
    stringField(value, "userPreferred"),
    stringField(value, "english"),
    stringField(value, "romaji"),
    stringField(value, "native"),
  ].filter((item): item is string => item !== undefined);
};

const makeEntry = (
  provider: CanonicalEntry["provider"],
  providerId: string,
  titleCandidates: readonly string[],
  value: JsonObject,
  score: number,
  externalIds: CanonicalEntry["externalIds"],
): CanonicalSearchResult => {
  const aliases = uniqueStrings(titleCandidates);
  const title = aliases[0] ?? `${provider} ${providerId}`;
  return {
    id: canonicalId(provider, providerId),
    provider,
    providerId,
    title,
    aliases,
    ...(externalIds && Object.keys(externalIds).length > 0 && { externalIds }),
    metadata: metadata(value),
    score,
  };
};

const anilistMedia = (value: JsonValue | undefined): CanonicalSearchResult | undefined => {
  if (value === undefined || !isJsonObject(value)) {
    return undefined;
  }
  const id = numberField(value, "id");
  if (id === undefined) {
    return undefined;
  }
  const idMal = numberField(value, "idMal");
  const titles = [...titleValues(value.title), ...stringsFrom(value.synonyms)];
  const averageScore = numberField(value, "averageScore");
  const mangaDexId = mangaDexExternalId(value.externalLinks);
  return makeEntry(
    "anilist",
    String(id),
    titles,
    value,
    averageScore === undefined ? 0 : averageScore / 100,
    {
      anilist: String(id),
      ...(idMal !== undefined && { mal: String(idMal) }),
      ...(mangaDexId !== undefined && { mangadex: mangaDexId }),
    },
  );
};

const anilistGraphQLError = (body: JsonObject): CanonicalSourceError | undefined => {
  const errors = arrayField(body, "errors") ?? [];
  const messages = errors.flatMap((error) => {
    if (!isJsonObject(error)) {
      return [];
    }
    const message = stringField(error, "message");
    return message === undefined ? [] : [message];
  });
  const status = errors.flatMap((error) => {
    const value = isJsonObject(error) ? numberField(error, "status") : undefined;
    return value === undefined ? [] : [value];
  })[0];
  return errors.length > 0
    ? sourceError("anilist", messages.join("; ") || "AniList GraphQL request failed", status)
    : undefined;
};

const anilistMediaFields = `
  id
  idMal
  title { romaji english native userPreferred }
  synonyms
  description
  startDate { year month day }
  endDate { year month day }
  chapters
  volumes
  status
  averageScore
  coverImage { extraLarge large medium }
  externalLinks { site url }
  siteUrl
`;

const anilistSearchQuery = `
  query SearchManga($search: String!, $page: Int!, $perPage: Int!) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: MANGA) {
        ${anilistMediaFields}
      }
    }
  }
`;

const anilistGetQuery = `
  query GetManga($id: Int!) {
    Media(id: $id, type: MANGA) {
      ${anilistMediaFields}
    }
  }
`;

const anilistGetByMalQuery = `
  query GetMangaByIdMal($idMal: Int!) {
    Media(idMal: $idMal, type: MANGA) {
      ${anilistMediaFields}
    }
  }
`;

const limitFrom = (options: CanonicalSearchOptions | undefined): number => {
  const limit = options?.limit ?? 20;
  if (!Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(25, Math.max(1, Math.floor(limit)));
};

const requireQuery = (query: string, provider: CanonicalSourceError["provider"]): string => {
  const normalized = query.trim();
  if (!normalized) {
    throw sourceError(provider, "Canonical search query cannot be empty");
  }
  return normalized;
};

export const normalizeAniListMedia = anilistMedia;

export const createAniListSource = (options: AniListSourceOptions = {}): CanonicalSearchSource => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const endpoint = options.endpoint ?? ANILIST_GRAPHQL_ENDPOINT;

  const request = (query: string, variables: JsonObject) =>
    requestJson("anilist", fetcher, endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": options.userAgent ?? manifoldUserAgent("canonical"),
      },
      body: jsonBodyString({ query, variables }),
    });

  return {
    provider: "anilist",
    search: (query, searchOptions) =>
      Effect.gen(function* () {
        const body = yield* request(anilistSearchQuery, {
          search: yield* Effect.try({ try: () => requireQuery(query, "anilist"), catch: (e) => (isSourceError(e) ? e : sourceError("anilist", "bad query")) }),
          page: 1,
          perPage: limitFrom(searchOptions),
        });
        const graphQLError = anilistGraphQLError(body);
        if (graphQLError) {
          return yield* Effect.fail(graphQLError);
        }
        const data = objectField(body, "data");
        const page = data === undefined ? undefined : objectField(data, "Page");
        const media = page === undefined ? undefined : arrayField(page, "media");
        if (!media) {
          return yield* Effect.fail(sourceError("anilist", "AniList search returned no media array"));
        }
        return media.flatMap((item) => {
          const result = anilistMedia(item);
          return result === undefined ? [] : [result];
        });
      }),
    getById: (providerId) =>
      Effect.gen(function* () {
        const id = Number.parseInt(providerId, 10);
        if (!Number.isSafeInteger(id)) {
          return yield* Effect.fail(sourceError("anilist", `Invalid AniList manga id: ${providerId}`));
        }
        const body = yield* request(anilistGetQuery, { id });
        const graphQLError = anilistGraphQLError(body);
        if (graphQLError) {
          return yield* Effect.fail(graphQLError);
        }
        const data = objectField(body, "data");
        return anilistMedia(data === undefined ? undefined : objectField(data, "Media"));
      }),
    getByIdMal: (idMal) =>
      Effect.gen(function* () {
        const id = Number.parseInt(idMal, 10);
        if (!Number.isSafeInteger(id)) {
          return yield* Effect.fail(sourceError("anilist", `Invalid MyAnimeList manga id: ${idMal}`));
        }
        const body = yield* request(anilistGetByMalQuery, { idMal: id });
        const graphQLError = anilistGraphQLError(body);
        if (graphQLError) {
          if (graphQLError.message.includes("Not Found")) {
            return undefined;
          }
          return yield* Effect.fail(graphQLError);
        }
        const data = objectField(body, "data");
        return anilistMedia(data === undefined ? undefined : objectField(data, "Media"));
      }),
  };
};


const malFields = [
  "alternative_titles",
  "authors",
  "genres",
  "main_picture",
  "media_type",
  "num_chapters",
  "num_volumes",
  "start_date",
  "end_date",
  "mean",
  "status",
  "synopsis",
].join(",");

const malEntry = (value: JsonValue | undefined): CanonicalSearchResult | undefined => {
  if (value === undefined || !isJsonObject(value)) {
    return undefined;
  }
  const id = numberField(value, "id");
  const title = stringField(value, "title");
  if (id === undefined || title === undefined) {
    return undefined;
  }
  const alternativeTitles = objectField(value, "alternative_titles");
  const aliases = [
    title,
    alternativeTitles === undefined ? undefined : stringField(alternativeTitles, "en"),
    alternativeTitles === undefined ? undefined : stringField(alternativeTitles, "ja"),
    ...stringsFrom(alternativeTitles?.synonyms),
  ];
  const picture = objectField(value, "main_picture");
  const description = stringField(value, "synopsis");
  const coverUrl =
    picture === undefined
      ? undefined
      : (stringField(picture, "large") ?? stringField(picture, "medium"));
  const chapters = numberField(value, "num_chapters");
  const volumes = numberField(value, "num_volumes");
  const startDate = stringField(value, "start_date");
  const endDate = stringField(value, "end_date");
  const status = stringField(value, "status");
  const resultMetadata: CanonicalMetadata = {
    ...(description !== undefined && { description }),
    ...(coverUrl !== undefined && { coverUrl }),
    ...(chapters !== undefined && { chapters }),
    ...(volumes !== undefined && { volumes }),
    ...(startDate !== undefined && { startDate }),
    ...(endDate !== undefined && { endDate }),
    ...(status !== undefined && { status }),
  };
  const mean = numberField(value, "mean");
  return {
    id: canonicalId("mal", String(id)),
    provider: "mal",
    providerId: String(id),
    title,
    aliases: uniqueStrings(aliases),
    externalIds: { mal: String(id) },
    metadata: resultMetadata,
    score: mean === undefined ? 0 : mean / 10,
  };
};

export const normalizeMyAnimeListManga = malEntry;

export const createMyAnimeListSource = (
  options: MyAnimeListSourceOptions,
): CanonicalSearchSource => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const endpoint = options.endpoint ?? MYANIMELIST_MANGA_ENDPOINT;

  const request = (href: string) =>
    requestJson("mal", fetcher, href, {
      headers: {
        accept: "application/json",
        "X-MAL-CLIENT-ID": options.clientId,
        "user-agent": options.userAgent ?? manifoldUserAgent("canonical"),
      },
    });

  return {
    provider: "mal",
    search: (query, searchOptions) =>
      Effect.gen(function* () {
        if (!options.clientId || options.clientId === "not-configured") {
          return yield* Effect.fail(sourceError("mal", "MyAnimeList client id is not configured"));
        }
        const normalized = yield* Effect.try({ try: () => requireQuery(query, "mal"), catch: (e) => (isSourceError(e) ? e : sourceError("mal", "bad query")) });
        if (Array.from(normalized).length < 3) {
          return yield* Effect.fail(
            sourceError("mal", "MyAnimeList search requires at least 3 characters", 400),
          );
        }
        const q = encodeURIComponent(normalized);
        const limit = encodeURIComponent(String(limitFrom(searchOptions)));
        const fields = encodeURIComponent(malFields);
        const href = `${endpoint}?q=${q}&limit=${limit}&fields=${fields}`;
        const body = yield* request(href);
        const data = arrayField(body, "data");
        if (!data) {
          return yield* Effect.fail(sourceError("mal", "MyAnimeList search returned no data array"));
        }
        return data.flatMap((item) => {
          const result = malEntry(isJsonObject(item) ? objectField(item, "node") : undefined);
          return result === undefined ? [] : [result];
        });
      }),
    getById: (providerId) =>
      Effect.gen(function* () {
        if (!options.clientId || options.clientId === "not-configured") {
          return yield* Effect.fail(sourceError("mal", "MyAnimeList client id is not configured"));
        }
        const href = `${endpoint}/${encodeURIComponent(providerId)}?fields=${encodeURIComponent(malFields)}`;
        const body = yield* request(href);
        return malEntry(body);
      }),
  };
};

