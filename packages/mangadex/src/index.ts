import * as Effect from "effect/Effect";

export const MANGADEX_TOKEN_ENDPOINT =
  "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token";
export const MANGADEX_API_ORIGIN = "https://api.mangadex.org";
export const MANGADEX_COVER_ORIGIN = "https://uploads.mangadex.org/covers";
export const MANGADEX_USER_AGENT = "manifold/0.1 (+https://manifold.jfa.dev)";
export const MANGADEX_CONTENT_RATINGS = ["safe", "suggestive", "erotica", "pornographic"] as const;

export interface MangaDexPersonalClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly username: string;
  readonly password: string;
}

export const createMangaDexPasswordGrant = (
  credentials: MangaDexPersonalClientCredentials
): URLSearchParams =>
  new URLSearchParams({
    grant_type: "password",
    username: credentials.username,
    password: credentials.password,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret
  });

export const createMangaDexRefreshGrant = (
  credentials: Pick<MangaDexPersonalClientCredentials, "clientId" | "clientSecret">,
  refreshToken: string
): URLSearchParams =>
  new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret
  });

export type MangaDexMangaId = string;
export type MangaDexChapterId = string;

export interface MangaDexManga {
  readonly id: MangaDexMangaId;
  readonly title: string;
  readonly altTitles: readonly string[];
  readonly anilistId?: string;
  readonly myAnimeListId?: string;
  readonly description?: string;
  readonly coverUrl?: string;
  readonly status?: string;
  readonly year?: number;
}

export interface MangaDexChapter {
  readonly id: MangaDexChapterId;
  readonly mangaId: MangaDexMangaId;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly language: string;
  readonly title?: string;
  readonly externalUrl?: string;
  readonly pageCount?: number;
  readonly publishedAt?: number;
}

export interface MangaDexPage {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

export interface MangaDexChapterDetails {
  readonly id: MangaDexChapterId;
  readonly mangaId: MangaDexMangaId;
  readonly pages: readonly MangaDexPage[];
}

export interface MangaDexSourceError {
  readonly _tag: "MangaDexSourceError";
  readonly message: string;
  readonly status?: number;
}

export interface MangaDexMangaListOptions {
  readonly ids?: readonly MangaDexMangaId[];
  readonly orderKey?: string;
  readonly orderValue?: "asc" | "desc";
  readonly createdAtSince?: string;
  readonly hasAvailableChapters?: boolean;
  readonly contentRating?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface MangaDexChapterFeedOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly languages?: readonly string[];
  readonly publishedAtSince?: string;
  readonly contentRating?: readonly string[];
}

export interface MangaDexPaged<T> {
  readonly items: readonly T[];
  readonly total?: number;
}

export type MangaDexReadingStatus =
  | "reading"
  | "on_hold"
  | "plan_to_read"
  | "dropped"
  | "re_reading"
  | "completed";

export interface MangaDexRating {
  readonly rating: number;
  readonly createdAt: string;
}

export interface MangaDexClient {
  readonly search: (
    query: string
  ) => Effect.Effect<readonly MangaDexManga[], MangaDexSourceError>;
  readonly listManga: (
    options: MangaDexMangaListOptions
  ) => Effect.Effect<MangaDexPaged<MangaDexManga>, MangaDexSourceError>;
  readonly getManga: (
    mangaId: MangaDexMangaId
  ) => Effect.Effect<MangaDexManga, MangaDexSourceError>;
  readonly getChapters: (
    mangaId: MangaDexMangaId
  ) => Effect.Effect<readonly MangaDexChapter[], MangaDexSourceError>;
  readonly latestChapters: (
    options: MangaDexChapterFeedOptions
  ) => Effect.Effect<MangaDexPaged<MangaDexChapter>, MangaDexSourceError>;
  readonly followedFeed: (
    options: MangaDexChapterFeedOptions
  ) => Effect.Effect<MangaDexPaged<MangaDexChapter>, MangaDexSourceError>;
  readonly followedManga: (
    options?: { readonly limit?: number; readonly offset?: number }
  ) => Effect.Effect<MangaDexPaged<MangaDexManga>, MangaDexSourceError>;
  /** The manga's newest chapter published at or after the cutoff, if any. */
  readonly latestChapterSince: (
    mangaId: MangaDexMangaId,
    publishedAtSince: string
  ) => Effect.Effect<MangaDexChapter | undefined, MangaDexSourceError>;
  /** One page of the manga's own chapter feed, newest first. */
  readonly feedChapters: (
    mangaId: MangaDexMangaId,
    options?: MangaDexChapterFeedOptions
  ) => Effect.Effect<MangaDexPaged<MangaDexChapter>, MangaDexSourceError>;
  readonly getChapterDetails: (
    chapterId: MangaDexChapterId
  ) => Effect.Effect<MangaDexChapterDetails, MangaDexSourceError>;
  readonly markChaptersRead: (
    mangaId: MangaDexMangaId,
    chapterIds: readonly MangaDexChapterId[]
  ) => Effect.Effect<void, MangaDexSourceError>;
  readonly readingStatuses: (options?: {
    readonly status?: MangaDexReadingStatus;
  }) => Effect.Effect<
    Readonly<Record<string, MangaDexReadingStatus>>,
    MangaDexSourceError
  >;
  readonly updateReadingStatus: (
    mangaId: MangaDexMangaId,
    status: MangaDexReadingStatus | null
  ) => Effect.Effect<void, MangaDexSourceError>;
  readonly currentUser: () => Effect.Effect<
    { readonly id: string; readonly name?: string },
    MangaDexSourceError
  >;
  readonly readMarkers: (
    mangaId: MangaDexMangaId
  ) => Effect.Effect<readonly string[], MangaDexSourceError>;
  /** Read-marker chapter ids for many mangas in one batched call per 100 ids. */
  readonly readMarkersBulk: (
    mangaIds: readonly MangaDexMangaId[]
  ) => Effect.Effect<Readonly<Record<string, readonly string[]>>, MangaDexSourceError>;
  /** Authenticated user ratings for many mangas — missing keys mean unrated. Batched at 100 ids per request. */
  readonly getRatings: (
    mangaIds: readonly MangaDexMangaId[]
  ) => Effect.Effect<Readonly<Record<string, MangaDexRating>>, MangaDexSourceError>;
  readonly followManga: (
    mangaId: MangaDexMangaId
  ) => Effect.Effect<void, MangaDexSourceError>;
  readonly unfollowManga: (
    mangaId: MangaDexMangaId
  ) => Effect.Effect<void, MangaDexSourceError>;
  readonly isFollowingManga: (
    mangaId: MangaDexMangaId
  ) => Effect.Effect<boolean, MangaDexSourceError>;
}

export type MangaDexFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MangaDexClientOptions {
  readonly endpoint?: string;
  readonly fetcher?: MangaDexFetcher;
  readonly accessToken?: string;
  readonly languages?: readonly string[];
  readonly limit?: number;
  /** Base backoff for retrying transient failures; doubles each attempt. */
  readonly retryDelayMs?: number;
}

type JsonRecord = Record<string, unknown>;

const defaultFetcher: MangaDexFetcher = (input, init) => fetch(input, init);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {return value;}
  if (typeof value !== "string" || value.trim().length === 0) {return undefined;}
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const objectValues = (value: unknown): readonly JsonRecord[] =>
  Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== undefined)
    : [];

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

const preferredLocalizedValue = (value: unknown): string | undefined => {
  const values = record(value);
  if (!values) {return stringValue(value);}
  return [values.en, values["ja-ro"], values.ja, ...Object.values(values)]
    .map(stringValue)
    .find((item): item is string => item !== undefined);
};

const mangaFromResource = (value: unknown): MangaDexManga | undefined => {
  const resource = record(value);
  const id = stringValue(resource?.id);
  const attributes = record(resource?.attributes);
  if (!id || !attributes) {return undefined;}

  const title = preferredLocalizedValue(attributes.title) ?? id;
  const links = record(attributes.links);
  const altTitles = objectValues(attributes.altTitles).flatMap((item) =>
    Object.values(item).map(stringValue),
  );
  const relationships = objectValues(resource?.relationships);
  const cover = relationships.find((item) => item.type === "cover_art");
  const coverFileName = stringValue(record(cover?.attributes)?.fileName);

  return {
    id,
    title,
    altTitles: uniqueStrings([title, ...altTitles]).slice(1),
    ...(stringValue(links?.al) ? { anilistId: stringValue(links?.al) } : {}),
    ...(stringValue(links?.mal) ? { myAnimeListId: stringValue(links?.mal) } : {}),
    ...(preferredLocalizedValue(attributes.description)
      ? { description: preferredLocalizedValue(attributes.description) }
      : {}),
    ...(coverFileName ? { coverUrl: `${MANGADEX_COVER_ORIGIN}/${id}/${coverFileName}.512.jpg` } : {}),
    ...(stringValue(attributes.status) ? { status: stringValue(attributes.status) } : {}),
    ...(numberValue(attributes.year) === undefined ? {} : { year: numberValue(attributes.year) }),
  };
};

const chapterFromResource = (value: unknown): MangaDexChapter | undefined => {
  const resource = record(value);
  const attributes = record(resource?.attributes);
  const id = stringValue(resource?.id);
  const relationships = objectValues(resource?.relationships);
  const mangaId = stringValue(relationships.find((item) => item.type === "manga")?.id);
  if (!id || !attributes || !mangaId) {return undefined;}

  const publishedAt = stringValue(attributes.publishAt);
  const timestamp = publishedAt === undefined ? undefined : Date.parse(publishedAt);

  return {
    id,
    mangaId,
    ...(numberValue(attributes.chapter) === undefined
      ? {}
      : { chapterNumber: numberValue(attributes.chapter) }),
    ...(numberValue(attributes.volume) === undefined
      ? {}
      : { volumeNumber: numberValue(attributes.volume) }),
    language: stringValue(attributes.translatedLanguage) ?? "en",
    ...(stringValue(attributes.title) ? { title: stringValue(attributes.title) } : {}),
    ...(stringValue(attributes.externalUrl) ? { externalUrl: stringValue(attributes.externalUrl) } : {}),
    ...(numberValue(attributes.pages) === undefined ? {} : { pageCount: numberValue(attributes.pages) }),
    ...(timestamp === undefined || Number.isNaN(timestamp) ? {} : { publishedAt: timestamp }),
  };
};

const pageFromValue = (
  value: unknown,
  baseUrl: string,
  hash: string,
): MangaDexPage | undefined => {
  const page = record(value);
  const filename = stringValue(page?.filename ?? value);
  if (!filename) {return undefined;}
  const url = filename.startsWith("http")
    ? filename
    : `${baseUrl}/data/${hash}/${filename}`;
  return {
    url,
    ...(numberValue(page?.width) === undefined ? {} : { width: numberValue(page?.width) }),
    ...(numberValue(page?.height) === undefined ? {} : { height: numberValue(page?.height) }),
  };
};

const errorFrom = (cause: unknown, status?: number): MangaDexSourceError => ({
  _tag: "MangaDexSourceError",
  message:
    typeof cause === "string"
      ? cause
      : cause instanceof Error
        ? cause.message
        : "MangaDex request failed",
  ...(status === undefined ? {} : { status }),
});

const isSourceError = (value: unknown): value is MangaDexSourceError =>
  isRecord(value) && value._tag === "MangaDexSourceError" && typeof value.message === "string";

const withSourceError = <A>(action: () => Promise<A>): Effect.Effect<A, MangaDexSourceError> =>
  Effect.tryPromise({
    try: action,
    catch: (cause) => (isSourceError(cause) ? cause : errorFrom(cause)),
  });

const normalizedLimit = (value: number | undefined, max = 100): number => {
  if (value === undefined || !Number.isFinite(value)) {return Math.min(100, max);}
  return Math.min(max, Math.max(1, Math.floor(value)));
};

const queryPath = (
  path: string,
  params: readonly (readonly [string, string])[],
): string => {
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parseChaptersPage = async (
  jsonPromise: Promise<unknown>,
): Promise<{ chapters: readonly MangaDexChapter[]; total: number | undefined }> => {
  const body = record(await jsonPromise);
  const chapters = Array.isArray(body?.data)
    ? body.data.flatMap((item) => {
        const chapter = chapterFromResource(item);
        return chapter ? [chapter] : [];
      })
    : [];
  return { chapters, total: numberValue(body?.total) };
};

export const createMangaDexClient = (
  options: MangaDexClientOptions = {},
): MangaDexClient => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const endpoint = (options.endpoint ?? MANGADEX_API_ORIGIN).replace(/\/$/, "");
  const languages = options.languages ?? ["en"];
  const limit = normalizedLimit(options.limit);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
  const maxAttempts = 4;

  // MangaDex throws sporadic 5xx/429 during long sweeps; all writes this
  // client performs are idempotent, so retry those with exponential backoff
  // (honoring Retry-After when present) before surfacing an error.
  const retryWaitMs = (response: Response | undefined, attempt: number): number => {
    if (response) {
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {return retryAfter * 1000;}
    }
    return retryDelayMs * 2 ** (attempt - 1);
  };

  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    attempt = 1,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": MANGADEX_USER_AGENT,
    };
    if (options.accessToken) {headers.authorization = `Bearer ${options.accessToken}`;}
    if (body !== undefined) {headers["content-type"] = "application/json";}
    let response: Response;
    try {
      response = await fetcher(`${endpoint}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (attempt < maxAttempts) {
        await sleep(retryWaitMs(undefined, attempt));
        return request(path, method, body, attempt + 1);
      }
      throw errorFrom(cause);
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        await sleep(retryWaitMs(response, attempt));
        return request(path, method, body, attempt + 1);
      }
      const detail = await response.text().catch(() => "");
      throw {
        _tag: "MangaDexSourceError",
        message:
          `MangaDex returned HTTP ${response.status}` +
          (detail ? `: ${detail.slice(0, 300)}` : ""),
        status: response.status,
      } satisfies MangaDexSourceError;
    }
    return response;
  };

  const requestJson = async (path: string): Promise<unknown> =>
    // SAFETY: test/double or boundary cast through unknown to Promise<unknown>;
    (await request(path)).json() as Promise<unknown>;

  const getChaptersPage = async (
    mangaId: string,
    offset: number,
  ): Promise<{ chapters: readonly MangaDexChapter[]; total: number | undefined }> => {
    const params: Array<readonly [string, string]> = [
      ["limit", String(limit)],
      ["offset", String(offset)],
      ["order[chapter]", "asc"],
      ["order[volume]", "asc"],
      ["manga", mangaId],
      ...languages.map((language) => ["translatedLanguage[]", language] as const),
    ];
    return parseChaptersPage(requestJson(queryPath("/chapter", params)));
  };

  const chapterFeedPage = async (
    path: string,
    feedOptions: MangaDexChapterFeedOptions,
  ): Promise<MangaDexPaged<MangaDexChapter>> => {
    // The followed-manga feed allows up to 500 per page.
    const pageLimit = normalizedLimit(feedOptions.limit, 500);
    const params: Array<readonly [string, string]> = [
      ["limit", String(pageLimit)],
      ["offset", String(feedOptions.offset ?? 0)],
      ["order[readableAt]", "desc"],
      ...(feedOptions.publishedAtSince
        ? ([["publishAtSince", feedOptions.publishedAtSince]] as const)
        : []),
      // The API silently excludes pornographic titles from feeds unless all
      // ratings are requested explicitly.
      ...(feedOptions.contentRating ?? MANGADEX_CONTENT_RATINGS).map(
        (rating) => ["contentRating[]", rating] as const,
      ),
      ...(feedOptions.languages ?? languages).map(
        (language) => ["translatedLanguage[]", language] as const,
      ),
    ];
    const page = await parseChaptersPage(requestJson(queryPath(path, params)));
    return { items: page.chapters, total: page.total };
  };

  return {
    search: (query) =>
      withSourceError(async () => {
        const normalized = query.trim();
        if (!normalized) {throw errorFrom("MangaDex search query cannot be empty");}
        // MangaDex defaults title search to safe+suggestive and silently
        // hides erotica/pornographic entries — which are exactly the ones
        // this private stack tracks. Ask for everything.
        const body = record(await requestJson(queryPath("/manga", [
          ["title", normalized],
          ["limit", String(limit)],
          ["includes[]", "cover_art"],
          ...MANGADEX_CONTENT_RATINGS.map(
            (rating) => ["contentRating[]", rating] as const,
          ),
        ])));
        return Array.isArray(body?.data)
          ? body.data.flatMap((item) => {
              const manga = mangaFromResource(item);
              return manga ? [manga] : [];
            })
          : [];
      }),
    listManga: (listOptions) =>
      withSourceError(async () => {
        const pageLimit = normalizedLimit(listOptions.limit);
        const params: Array<readonly [string, string]> = [
          ["limit", String(pageLimit)],
          ["offset", String(listOptions.offset ?? 0)],
          ["includes[]", "cover_art"],
          ...(listOptions.orderKey
            ? ([[`order[${listOptions.orderKey}]`, listOptions.orderValue ?? "desc"]] as const)
            : []),
          ...(listOptions.ids ?? []).map((id) => ["ids[]", id] as const),
          ...(listOptions.hasAvailableChapters
            ? ([["hasAvailableChapters", "true"]] as const)
            : []),
          ...(listOptions.createdAtSince
            ? ([["createdAtSince", listOptions.createdAtSince]] as const)
            : []),
          // The API silently defaults to safe+suggestive and hides adult
          // titles even for ids[] lookups — always ask explicitly. Default
          // to the full rating set so callers never get invisible “untitled”
          // rows (the admin library hit this for erotica/pornographic titles).
          // SAFETY: value matches readonly string[]).map( at this call site
          ...((listOptions.contentRating ?? MANGADEX_CONTENT_RATINGS) as readonly string[]).map(
            (rating) => ["contentRating[]", rating] as const,
          ),
        ];
        const body = record(await requestJson(queryPath("/manga", params)));
        const items = Array.isArray(body?.data)
          ? body.data.flatMap((item) => {
              const manga = mangaFromResource(item);
              return manga ? [manga] : [];
            })
          : [];
        return { items, total: numberValue(body?.total) };
      }),
    getManga: (mangaId) =>
      withSourceError(async () => {
        const path = queryPath(`/manga/${encodeURIComponent(mangaId)}`, [["includes[]", "cover_art"]]);
        const body = record(await requestJson(path));
        const manga = mangaFromResource(body?.data);
        if (!manga) {throw errorFrom(`MangaDex manga not found: ${mangaId}`, 404);}
        return manga;
      }),
    getChapters: (mangaId) =>
      withSourceError(async () => {
        const all: MangaDexChapter[] = [];
        for (let offset = 0; ; offset += limit) {
          const page = await getChaptersPage(mangaId, offset);
          all.push(...page.chapters);
          if (page.chapters.length < limit || page.total === undefined || all.length >= page.total) {
            return all;
          }
        }
      }),
    latestChapters: (feedOptions) =>
      withSourceError(() => chapterFeedPage("/chapter", feedOptions)),
    followedFeed: (feedOptions) =>
      withSourceError(() => chapterFeedPage("/user/follows/manga/feed", feedOptions)),
    feedChapters: (mangaId, feedOptions = {}) =>
      withSourceError(() =>
        chapterFeedPage(`/manga/${encodeURIComponent(mangaId)}/feed`, feedOptions),
      ),
    followedManga: (listOptions) =>
      withSourceError(async () => {
        const pageLimit = normalizedLimit(listOptions?.limit);
        const params: Array<readonly [string, string]> = [
          ["limit", String(pageLimit)],
          ["offset", String(listOptions?.offset ?? 0)],
        ];
        const body = record(await requestJson(queryPath("/user/follows/manga", params)));
        const items = Array.isArray(body?.data)
          ? body.data.flatMap((item) => {
              const manga = mangaFromResource(item);
              return manga ? [manga] : [];
            })
          : [];
        return { items, total: numberValue(body?.total) };
      }),
    latestChapterSince: (mangaId, publishedAtSince) =>
      withSourceError(async () => {
        const path = queryPath(`/manga/${encodeURIComponent(mangaId)}/feed`, [
          ["limit", "1"],
          ["order[readableAt]", "desc"],
          ["publishAtSince", publishedAtSince],
          ...languages.map((language) => ["translatedLanguage[]", language] as const),
        ]);
        const page = await parseChaptersPage(requestJson(path));
        return page.chapters[0];
      }),
    getChapterDetails: (chapterId) =>
      withSourceError(async () => {
        const body = record(await requestJson(`/at-home/server/${encodeURIComponent(chapterId)}`));
        const chapter = record(body?.chapter);
        const baseUrl = stringValue(body?.baseUrl);
        const hash = stringValue(chapter?.hash);
        if (!baseUrl || !hash) {throw errorFrom(`MangaDex page server returned no hash: ${chapterId}`);}
        const filenames = Array.isArray(chapter?.data) ? chapter.data : [];
        const pages = filenames
          .map((value) => pageFromValue(value, baseUrl, hash))
          .filter((page): page is MangaDexPage => page !== undefined);
        const mangaId = stringValue(chapter?.mangaId) ?? "";
        return { id: chapterId, mangaId, pages };
      }),
    markChaptersRead: (mangaId, chapterIds) =>
      withSourceError(async () => {
        if (chapterIds.length === 0) {return;}
        await request(
          `/manga/${encodeURIComponent(mangaId)}/read`,
          "POST",
          { chapterIdsRead: [...chapterIds] },
        );
      }),
    readingStatuses: (statusOptions) =>
      withSourceError(async () => {
        const path =
          statusOptions?.status === undefined
            ? "/manga/status"
            : queryPath("/manga/status", [["status", statusOptions.status]]);
        const body = record(await requestJson(path));
        const statuses = record(body?.statuses);
        const result: Record<string, MangaDexReadingStatus> = {};
        for (const [mangaId, status] of Object.entries(statuses ?? {})) {
          if (
            status === "reading" ||
            status === "on_hold" ||
            status === "plan_to_read" ||
            status === "dropped" ||
            status === "re_reading" ||
            status === "completed"
          ) {
            result[mangaId] = status;
          }
        }
        return result;
      }),
    updateReadingStatus: (mangaId, status) =>
      withSourceError(async () => {
        await request(
          `/manga/${encodeURIComponent(mangaId)}/status`,
          "POST",
          { status: status ?? null },
        );
      }),
    currentUser: () =>
      withSourceError(async () => {
        const body = record(await requestJson("/user/me"));
        const data = record(body?.data);
        const id = stringValue(data?.id);
        if (!id) {throw errorFrom("MangaDex returned no current user", 401);}
        const attributes = record(data?.attributes);
        return { id, ...(stringValue(attributes?.username) ? { name: stringValue(attributes?.username) } : {}) };
      }),
    readMarkers: (mangaId) =>
      withSourceError(async () => {
        const body = record(await requestJson(`/manga/${encodeURIComponent(mangaId)}/read`));
        const chapters = body?.data;
        return Array.isArray(chapters)
          ? chapters.flatMap((value) => {
              const id = stringValue(value);
              return id ? [id] : [];
            })
          : [];
      }),
    readMarkersBulk: (mangaIds) =>
      withSourceError(async () => {
        const result: Record<string, string[]> = {};
        // ids[] accepts at most 100 manga per request.
        for (let index = 0; index < mangaIds.length; index += 100) {
          const chunk = mangaIds.slice(index, index + 100);
          const path = queryPath("/manga/read", [
            ...chunk.map((id) => ["ids[]", id] as const),
            ["grouped", "true"],
          ]);
          const body = record(await requestJson(path));
          // grouped=true returns { [mangaId]: chapterIds }; an empty history
          // degrades to the ungrouped array shape — treat as no markers.
          const grouped = record(body?.data);
          for (const [mangaId, chapters] of Object.entries(grouped ?? {})) {
            result[mangaId] = Array.isArray(chapters)
              ? chapters.flatMap((value) => {
                  const id = stringValue(value);
                  return id ? [id] : [];
                })
              : [];
          }
        }
        return result;
      }),
    getRatings: (mangaIds) =>
      withSourceError(async () => {
        const result: Record<string, MangaDexRating> = {};
        if (mangaIds.length === 0) {return result;}
        // MangaDex caps manga[] at 100 per request; response omits unrated keys.
        for (let index = 0; index < mangaIds.length; index += 100) {
          const chunk = mangaIds.slice(index, index + 100);
          if (chunk.length === 0) {continue;}
          const path = queryPath("/rating", chunk.map((id) => ["manga[]", id] as const));
          const body = record(await requestJson(path));
          const ratings = record(body?.ratings);
          for (const [mangaId, value] of Object.entries(ratings ?? {})) {
            const entry = record(value);
            const rating = numberValue(entry?.rating);
            const createdAt = stringValue(entry?.createdAt);
            if (rating === undefined || createdAt === undefined) {continue;}
            // Clamp to valid range; upstream already validates 1..10.
            if (!Number.isFinite(rating) || rating < 1 || rating > 10) {continue;}
            result[mangaId] = { rating, createdAt };
          }
        }
        return result;
      }),
    followManga: (mangaId) =>
      withSourceError(async () => {
        await request(`/manga/${encodeURIComponent(mangaId)}/follow`, "POST");
      }),
    unfollowManga: (mangaId) =>
      withSourceError(async () => {
        try {
          await request(`/manga/${encodeURIComponent(mangaId)}/follow`, "DELETE");
        } catch (cause) {
          if (isSourceError(cause) && cause.status === 404) {return;}
          throw cause;
        }
      }),
    isFollowingManga: (mangaId) =>
      withSourceError(async () => {
        try {
          await request(`/user/follows/manga/${encodeURIComponent(mangaId)}`);
          return true;
        } catch (cause) {
          if (isSourceError(cause) && cause.status === 404) {return false;}
          throw cause;
        }
      }),
  };
};
