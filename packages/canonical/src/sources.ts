import * as Effect from "effect/Effect";
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

export type CanonicalFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AniListSourceOptions {
  readonly fetcher?: CanonicalFetcher;
  readonly endpoint?: string;
}

export interface MyAnimeListSourceOptions {
  readonly clientId: string;
  readonly fetcher?: CanonicalFetcher;
  readonly endpoint?: string;
}

type JsonRecord = Record<string, unknown>;

const defaultFetcher: CanonicalFetcher = (input, init) => fetch(input, init);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const recordValue = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const stringsFrom = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const result = stringValue(item);
        return result ? [result] : [];
      })
    : [];

const mangaDexIdFromUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") {return undefined;}
  try {
    const url = new URL(value);
    if (url.hostname !== "mangadex.org" && url.hostname !== "www.mangadex.org") {
      return undefined;
    }
    const match = url.pathname.match(/^\/title\/([0-9a-f]{8}-[0-9a-f-]{27})(?:\/|$)/i);
    return match?.[1].toLowerCase();
  } catch {
    return undefined;
  }
};

const mangaDexExternalId = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {return undefined;}
  for (const link of value) {
    const record = recordValue(link);
    const id = mangaDexIdFromUrl(record?.url);
    if (id) {return id;}
  }
  return undefined;
};

const uniqueStrings = (values: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) {continue;}
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) {continue;}
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
  ...(status === undefined ? {} : { status }),
});

const isSourceError = (value: unknown): value is CanonicalSourceError =>
  isRecord(value) &&
  value._tag === "CanonicalSourceError" &&
  (value.provider === "anilist" || value.provider === "mal") &&
  typeof value.message === "string";

const withSourceError = <A>(
  provider: CanonicalSourceError["provider"],
  action: () => Promise<A>,
): Effect.Effect<A, CanonicalSourceError> =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => {
      if (isSourceError(cause)) {return cause;}
      return sourceError(
        provider,
        cause instanceof Error ? cause.message : "Canonical provider request failed",
      );
    },
  });

const requestJson = async (
  provider: CanonicalSourceError["provider"],
  fetcher: CanonicalFetcher,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await fetcher(input, init);
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
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
    console.error(`[Canonical:${provider}] ${message}`);
    throw sourceError(provider, message, response.status);
  }
  return response.json() as Promise<unknown>;
};

const dateFromParts = (value: unknown): string | undefined => {
  const parts = recordValue(value);
  if (!parts) {return undefined;}
  const year = numberValue(parts.year);
  const month = numberValue(parts.month);
  const day = numberValue(parts.day);
  if (year === undefined) {return undefined;}
  return [year, month, day]
    .filter((part): part is number => part !== undefined)
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
};

const metadata = (value: JsonRecord): CanonicalMetadata => {
  const cover = recordValue(value.coverImage);
  const result: CanonicalMetadata = {
    ...(stringValue(value.description) ? { description: stringValue(value.description) } : {}),
    ...(stringValue(cover?.extraLarge ?? cover?.large ?? cover?.medium)
      ? { coverUrl: stringValue(cover?.extraLarge ?? cover?.large ?? cover?.medium) }
      : {}),
    ...(numberValue(value.chapters) === undefined ? {} : { chapters: numberValue(value.chapters) }),
    ...(numberValue(value.volumes) === undefined ? {} : { volumes: numberValue(value.volumes) }),
    ...(dateFromParts(value.startDate) ? { startDate: dateFromParts(value.startDate) } : {}),
    ...(dateFromParts(value.endDate) ? { endDate: dateFromParts(value.endDate) } : {}),
    ...(stringValue(value.status) ? { status: stringValue(value.status) } : {}),
  };
  return result;
};

const titleValues = (value: unknown): string[] => {
  const title = recordValue(value);
  if (!title) {return [];}
  return [
    stringValue(title.userPreferred),
    stringValue(title.english),
    stringValue(title.romaji),
    stringValue(title.native),
  ].filter((item): item is string => item !== undefined);
};

const makeEntry = (
  provider: CanonicalEntry["provider"],
  providerId: string,
  titleCandidates: readonly string[],
  value: JsonRecord,
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
    ...(externalIds && Object.keys(externalIds).length > 0 ? { externalIds } : {}),
    metadata: metadata(value),
    score,
  };
};

const anilistMedia = (value: unknown): CanonicalSearchResult | undefined => {
  const media = recordValue(value);
  const id = numberValue(media?.id);
  if (id === undefined) {return undefined;}
  const idMal = numberValue(media?.idMal);
  const titles = [...titleValues(media?.title), ...stringsFrom(media?.synonyms)];
  const averageScore = numberValue(media?.averageScore);
  const mangaDexId = mangaDexExternalId(media?.externalLinks);
  return makeEntry(
    "anilist",
    String(id),
    titles,
    media ?? {},
    averageScore === undefined ? 0 : averageScore / 100,
    {
      anilist: String(id),
      ...(idMal === undefined ? {} : { mal: String(idMal) }),
      ...(mangaDexId === undefined ? {} : { mangadex: mangaDexId }),
    },
  );
};

const anilistGraphQLError = (body: unknown): CanonicalSourceError | undefined => {
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const messages = errors.flatMap((error) => {
    const message = isRecord(error) ? stringValue(error.message) : undefined;
    return message ? [message] : [];
  });
  return messages.length > 0 ? sourceError("anilist", messages.join("; ")) : undefined;
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
  if (!Number.isFinite(limit)) {return 20;}
  return Math.min(25, Math.max(1, Math.floor(limit)));
};

const requireQuery = (query: string, provider: CanonicalSourceError["provider"]): string => {
  const normalized = query.trim();
  if (!normalized) {throw sourceError(provider, "Canonical search query cannot be empty");}
  return normalized;
};

export const normalizeAniListMedia = anilistMedia;

export const createAniListSource = (
  options: AniListSourceOptions = {},
): CanonicalSearchSource => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const endpoint = options.endpoint ?? ANILIST_GRAPHQL_ENDPOINT;

  const request = (query: string, variables: JsonRecord) =>
    requestJson("anilist", fetcher, endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "manifold/0.1 (+https://manifold.jfa.dev)",
      },
      body: JSON.stringify({ query, variables }),
    });

  return {
    provider: "anilist",
    search: (query, searchOptions) =>
      withSourceError("anilist", async () => {
        const body = await request(anilistSearchQuery, {
          search: requireQuery(query, "anilist"),
          page: 1,
          perPage: limitFrom(searchOptions),
        });
        const graphQLError = anilistGraphQLError(body);
        if (graphQLError) {throw graphQLError;}
        const page = isRecord(isRecord(body) ? body.data : undefined)
          ? recordValue((body as JsonRecord).data)?.Page
          : undefined;
        const media = isRecord(page) && Array.isArray(page.media) ? page.media : [];
        return media.flatMap((item) => {
          const result = anilistMedia(item);
          return result ? [result] : [];
        });
      }),
    getById: (providerId) =>
      withSourceError("anilist", async () => {
        const id = Number.parseInt(providerId, 10);
        if (!Number.isSafeInteger(id)) {
          throw sourceError("anilist", `Invalid AniList manga id: ${providerId}`);
        }
        const body = await request(anilistGetQuery, { id });
        const graphQLError = anilistGraphQLError(body);
        if (graphQLError) {throw graphQLError;}
        const data = recordValue(isRecord(body) ? body.data : undefined);
        return anilistMedia(data?.Media);
      }),
    getByIdMal: (idMal) =>
      withSourceError("anilist", async () => {
        const id = Number.parseInt(idMal, 10);
        if (!Number.isSafeInteger(id)) {
          throw sourceError("anilist", `Invalid MyAnimeList manga id: ${idMal}`);
        }
        const body = await request(anilistGetByMalQuery, { idMal: id });
        const graphQLError = anilistGraphQLError(body);
        if (graphQLError) {
          if (graphQLError.message.includes("Not Found")) {return undefined;}
          throw graphQLError;
        }
        const data = recordValue(isRecord(body) ? body.data : undefined);
        return anilistMedia(data?.Media);
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

const dateValue = (value: unknown): string | undefined => stringValue(value);

const malEntry = (value: unknown): CanonicalSearchResult | undefined => {
  const node = recordValue(value);
  const id = numberValue(node?.id);
  const title = stringValue(node?.title);
  if (id === undefined || title === undefined) {return undefined;}
  const alternativeTitles = recordValue(node?.alternative_titles);
  const aliases = [
    title,
    stringValue(alternativeTitles?.en),
    stringValue(alternativeTitles?.ja),
    ...stringsFrom(alternativeTitles?.synonyms),
  ];
  const picture = recordValue(node?.main_picture);
  const resultMetadata: CanonicalMetadata = {
    ...(stringValue(node?.synopsis) ? { description: stringValue(node?.synopsis) } : {}),
    ...(stringValue(picture?.large ?? picture?.medium)
      ? { coverUrl: stringValue(picture?.large ?? picture?.medium) }
      : {}),
    ...(numberValue(node?.num_chapters) === undefined
      ? {}
      : { chapters: numberValue(node?.num_chapters) }),
    ...(numberValue(node?.num_volumes) === undefined
      ? {}
      : { volumes: numberValue(node?.num_volumes) }),
    ...(dateValue(node?.start_date) ? { startDate: dateValue(node?.start_date) } : {}),
    ...(dateValue(node?.end_date) ? { endDate: dateValue(node?.end_date) } : {}),
    ...(stringValue(node?.status) ? { status: stringValue(node?.status) } : {}),
  };
  const mean = numberValue(node?.mean);
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

  const request = (url: URL) =>
    requestJson("mal", fetcher, url, {
      headers: {
        accept: "application/json",
        "X-MAL-CLIENT-ID": options.clientId,
        "user-agent": "manifold/0.1 (+https://manifold.jfa.dev)",
      },
    });

  return {
    provider: "mal",
    search: (query, searchOptions) =>
      withSourceError("mal", async () => {
        if (!options.clientId || options.clientId === "not-configured") {
          throw sourceError("mal", "MyAnimeList client id is not configured");
        }
        const url = new URL(endpoint);
        url.searchParams.set("q", requireQuery(query, "mal"));
        url.searchParams.set("limit", String(limitFrom(searchOptions)));
        url.searchParams.set("fields", malFields);
        const body = await request(url);
        const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
        return data.flatMap((item) => {
          const result = malEntry(isRecord(item) ? item.node : undefined);
          return result ? [result] : [];
        });
      }),
    getById: (providerId) =>
      withSourceError("mal", async () => {
        if (!options.clientId || options.clientId === "not-configured") {
          throw sourceError("mal", "MyAnimeList client id is not configured");
        }
        const url = new URL(`${endpoint}/${encodeURIComponent(providerId)}`);
        url.searchParams.set("fields", malFields);
        const body = await request(url);
        return malEntry(body);
      }),
  };
};
