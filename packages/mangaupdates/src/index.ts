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

export const MANGAUPDATES_API_ORIGIN = "https://api.mangaupdates.com";
/** @deprecated Prefer manifoldUserAgent("mangaupdates") / withManifoldUserAgent. */
export const MANGAUPDATES_USER_AGENT = manifoldUserAgent("mangaupdates");

export interface MangaUpdatesSeries {
  readonly id: number;
  readonly title: string;
  readonly altTitles: readonly string[];
  readonly description?: string;
  readonly imageUrl?: string;
  readonly status?: string;
  readonly year?: number;
  readonly bayesianRating?: number;
  readonly latestChapter?: number;
  readonly type?: string;
}

export interface MangaUpdatesRelease {
  readonly seriesId: number;
  readonly title: string;
  readonly chapter?: string;
  readonly volume?: string;
  readonly groups?: readonly string[];
  readonly date?: string;
}

export interface MangaUpdatesPaged<T> {
  readonly items: readonly T[];
  readonly total?: number;
}

export interface MangaUpdatesSourceError {
  readonly _tag: "MangaUpdatesSourceError";
  readonly message: string;
  readonly status?: number;
}

export interface MangaUpdatesClient {
  readonly search: (query: string) => Promise<readonly MangaUpdatesSeries[]>;
  readonly getSeries: (id: number) => Promise<MangaUpdatesSeries>;
  readonly releases: (options: {
    search?: string;
    page?: number;
    perpage?: number;
    orderby?: "date" | "time" | "title" | "vol" | "chap";
  }) => Promise<MangaUpdatesPaged<MangaUpdatesRelease>>;
}

export type MangaUpdatesFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MangaUpdatesClientOptions {
  readonly endpoint?: string;
  readonly fetcher?: MangaUpdatesFetcher;
  /** Override outbound User-Agent (defaults to manifold/mangaupdates). */
  readonly userAgent?: string;
}

const defaultFetcher: MangaUpdatesFetcher = (input, init) => fetch(input, init);

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined;

const stringValue = (value: JsonValue | undefined): string | undefined =>
  isString(value) && value.trim().length > 0 ? value.trim() : undefined;

const seriesFromRecord = (value: JsonValue | undefined): MangaUpdatesSeries | undefined => {
  const rec = asObject(value);
  const recordData = asObject(rec?.record) ?? rec;
  if (recordData === undefined) {
    return undefined;
  }
  const id =
    numberField(recordData, "series_id") ??
    (rec === undefined ? undefined : numberField(rec, "series_id")) ??
    (rec === undefined ? undefined : numberField(rec, "id"));
  const title =
    stringField(recordData, "title") ?? (rec === undefined ? undefined : stringField(rec, "title"));
  if (id === undefined || title === undefined) {
    return undefined;
  }
  const associated = arrayField(recordData, "associated") ?? [];
  const altTitles = associated
    .map((item) => (isJsonObject(item) ? stringField(item, "title") : undefined))
    .filter((item): item is string => item !== undefined);
  const image = objectField(recordData, "image");
  const urlObj = image === undefined ? undefined : objectField(image, "url");
  const url = urlObj === undefined ? undefined : stringField(urlObj, "original");
  const description = stringField(recordData, "description");
  const status = stringField(recordData, "status");
  const year = numberField(recordData, "year");
  const bayesianRating = numberField(recordData, "bayesian_rating");
  const latestChapter = numberField(recordData, "latest_chapter");
  const type = stringField(recordData, "type");
  return {
    id,
    title,
    altTitles,
    ...(description !== undefined && { description }),
    ...(url !== undefined && { imageUrl: url }),
    ...(status !== undefined && { status }),
    ...(year !== undefined && { year }),
    ...(bayesianRating !== undefined && { bayesianRating }),
    ...(latestChapter !== undefined && { latestChapter }),
    ...(type !== undefined && { type }),
  };
};

const releaseFromRecord = (value: JsonValue | undefined): MangaUpdatesRelease | undefined => {
  const rec = asObject(value);
  const recordData = asObject(rec?.record) ?? rec;
  if (recordData === undefined) {
    return undefined;
  }
  const seriesId =
    numberField(recordData, "series_id") ??
    (rec === undefined ? undefined : numberField(rec, "series_id"));
  const title =
    stringField(recordData, "title") ?? (rec === undefined ? undefined : stringField(rec, "title"));
  if (seriesId === undefined || title === undefined) {
    return undefined;
  }
  const groupsRaw = recordData.groups;
  const groups = isJsonArray(groupsRaw)
    ? groupsRaw
        .map((item) => {
          const group = asObject(item);
          return stringValue(group?.name ?? item);
        })
        .filter((name): name is string => name !== undefined)
    : undefined;
  const chapter = stringField(recordData, "chapter");
  const volume = stringField(recordData, "volume");
  const date = stringField(recordData, "release_date") ?? stringField(recordData, "date");
  return {
    seriesId,
    title,
    ...(chapter !== undefined && { chapter }),
    ...(volume !== undefined && { volume }),
    ...(groups !== undefined && { groups }),
    ...(date !== undefined && { date }),
  };
};

const errorFrom = (cause: unknown, status?: number): MangaUpdatesSourceError => ({
  _tag: "MangaUpdatesSourceError",
  message:
    cause instanceof Error
      ? cause.message
      : isString(cause)
        ? cause
        : "MangaUpdates request failed",
  ...(status !== undefined && { status }),
});

const isSourceError = (value: unknown): value is MangaUpdatesSourceError =>
  isJsonObject(value) && value._tag === "MangaUpdatesSourceError" && isString(value.message);

const withSourceError = async <A>(action: () => Promise<A>): Promise<A> => {
  try {
    return await action();
  } catch (cause: unknown) {
    if (isSourceError(cause)) {
      throw cause;
    }
    throw errorFrom(cause);
  }
};

export const createMangaUpdatesClient = (
  options: MangaUpdatesClientOptions = {},
): MangaUpdatesClient => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const endpoint = (options.endpoint ?? `${MANGAUPDATES_API_ORIGIN}/v1`).replace(/\/$/, "");

  const request = async (path: string, method = "GET", body?: JsonValue): Promise<Response> => {
    // Accumulator: start empty so known literals are not widened into Record.
    const headers: Record<string, string> = {};
    headers.accept = "application/json";
    headers["user-agent"] = options.userAgent ?? MANGAUPDATES_USER_AGENT;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetcher(`${endpoint}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw errorFrom(`MangaUpdates returned HTTP ${response.status}`, response.status);
    }
    return response;
  };

  const requestJson = async (
    path: string,
    method = "GET",
    body?: JsonValue,
  ): Promise<JsonObject> => {
    const parsed: unknown = await (await request(path, method, body)).json();
    if (!isJsonObject(parsed)) {
      throw errorFrom("MangaUpdates returned a non-object JSON body");
    }
    return parsed;
  };

  return {
    search: (query) =>
      withSourceError(async () => {
        const normalized = query.trim();
        if (!normalized) {
          throw errorFrom("MangaUpdates search query cannot be empty");
        }
        const body = await requestJson("/series/search", "POST", {
          search: normalized,
          perpage: 25,
          page: 1,
        });
        const results = arrayField(body, "results") ?? [];
        return results
          .map(seriesFromRecord)
          .filter((item): item is MangaUpdatesSeries => item !== undefined);
      }),
    getSeries: (id) =>
      withSourceError(async () => {
        const body = await requestJson(`/series/${encodeURIComponent(String(id))}`, "GET");
        const series = seriesFromRecord(body);
        if (!series) {
          throw errorFrom(`MangaUpdates series not found: ${id}`, 404);
        }
        return series;
      }),
    releases: (releaseOptions) =>
      withSourceError(async () => {
        const page = releaseOptions.page ?? 1;
        const perpage = releaseOptions.perpage ?? 50;
        const body = await requestJson(`/releases/search`, "POST", {
          search: releaseOptions.search ?? "",
          page,
          perpage,
          ...(releaseOptions.orderby ? { orderby: releaseOptions.orderby } : { orderby: "date" }),
        });
        const results = arrayField(body, "results") ?? [];
        const items = results
          .map(releaseFromRecord)
          .filter((item): item is MangaUpdatesRelease => item !== undefined);
        return {
          items,
          total: numberField(body, "total_hits") ?? numberField(body, "total") ?? items.length,
        };
      }),
  };
};
