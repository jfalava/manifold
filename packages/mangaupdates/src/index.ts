

export const MANGAUPDATES_API_ORIGIN = "https://api.mangaupdates.com";
export const MANGAUPDATES_USER_AGENT = "manifold/0.1 (+https://manifold.jfa.dev)";

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

export type MangaUpdatesFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MangaUpdatesClientOptions {
  readonly endpoint?: string;
  readonly fetcher?: MangaUpdatesFetcher;
}

type JsonRecord = Record<string, unknown>;

const defaultFetcher: MangaUpdatesFetcher = (input, init) => fetch(input, init);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): JsonRecord | undefined => (isRecord(value) ? value : undefined);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {return value;}
  if (typeof value !== "string" || value.trim().length === 0) {return undefined;}
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const seriesFromRecord = (value: unknown): MangaUpdatesSeries | undefined => {
  const rec = record(value);
  // SAFETY: optional field is JsonRecord | undefined when present at this call site
  const recordData = (rec?.record as JsonRecord | undefined) ?? rec;
  const id = numberValue(recordData?.series_id ?? rec?.series_id ?? rec?.id);
  const title = stringValue(recordData?.title ?? rec?.title);
  if (id === undefined || !title) {return undefined;}
  const associated = Array.isArray(recordData?.associated) ? recordData.associated : [];
  const altTitles = associated
    .map((a) => stringValue(record(a)?.title))
    .filter((t): t is string => Boolean(t));
  const image = record(recordData?.image);
  const urlObj = record(image?.url);
  const url = stringValue(urlObj?.original ?? record(image?.url)?.original);
  return {
    id,
    title,
    altTitles,
    ...(stringValue(recordData?.description) ? { description: stringValue(recordData?.description) } : {}),
    ...(url ? { imageUrl: url } : {}),
    ...(stringValue(recordData?.status) ? { status: stringValue(recordData?.status) } : {}),
    ...(numberValue(recordData?.year) !== undefined ? { year: numberValue(recordData?.year) } : {}),
    ...(numberValue(recordData?.bayesian_rating) !== undefined
      ? { bayesianRating: numberValue(recordData?.bayesian_rating) }
      : {}),
    ...(numberValue(recordData?.latest_chapter) !== undefined
      ? { latestChapter: numberValue(recordData?.latest_chapter) }
      : {}),
    ...(stringValue(recordData?.type) ? { type: stringValue(recordData?.type) } : {}),
  };
};

const releaseFromRecord = (value: unknown): MangaUpdatesRelease | undefined => {
  const rec = record(value);
  // SAFETY: optional field is JsonRecord | undefined when present at this call site
  const recordData = (rec?.record as JsonRecord | undefined) ?? rec;
  // releases/search returns record.series_id as `series_id` inside `record`, but some firehose returns `id` as release id and `series_id` separate
  const seriesId = numberValue(
    // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
    (recordData as Record<string, unknown>)?.series_id ??
      // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
      (rec as Record<string, unknown>)?.series_id ??
      // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
      (recordData as Record<string, unknown>)?.series_id,
  );
  // The release title is in `title`, but for releases/search it's the manga title, not release title
  // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
  const title = stringValue((recordData as Record<string, unknown>)?.title ?? (rec as Record<string, unknown>)?.title);
  if (seriesId === undefined || !title) {return undefined;}
  // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
  const groupsRaw = (recordData as Record<string, unknown>)?.groups;
  const groups = Array.isArray(groupsRaw)
    ? groupsRaw
        .map((g) => {
          const gr = record(g);
          return stringValue(gr?.name ?? g);
        })
        .filter((n): n is string => Boolean(n))
    : undefined;
  return {
    seriesId,
    title,
    // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
    ...(stringValue((recordData as Record<string, unknown>)?.chapter)
      // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
      ? { chapter: stringValue((recordData as Record<string, unknown>)?.chapter) }
      : {}),
    // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
    ...(stringValue((recordData as Record<string, unknown>)?.volume)
      // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
      ? { volume: stringValue((recordData as Record<string, unknown>)?.volume) }
      : {}),
    ...(groups ? { groups } : {}),
    // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
    ...(stringValue((recordData as Record<string, unknown>)?.release_date ?? (recordData as Record<string, unknown>)?.date)
      // SAFETY: test/double or boundary cast through unknown to Record<string, unknown>
      ? { date: stringValue((recordData as Record<string, unknown>)?.release_date ?? (recordData as Record<string, unknown>)?.date) }
      : {}),
  };
};

const errorFrom = (cause: unknown, status?: number): MangaUpdatesSourceError => ({
  _tag: "MangaUpdatesSourceError",
  message: cause instanceof Error ? cause.message : "MangaUpdates request failed",
  ...(status === undefined ? {} : { status }),
});

const isSourceError = (value: unknown): value is MangaUpdatesSourceError =>
  isRecord(value) && value._tag === "MangaUpdatesSourceError" && typeof value.message === "string";

const withSourceError = async <A>(action: () => Promise<A>): Promise<A> => {
  try {
    return await action();
  } catch (cause: unknown) {
    if (isSourceError(cause)) {throw cause;}
    throw errorFrom(cause);
  }
};

export const createMangaUpdatesClient = (options: MangaUpdatesClientOptions = {}): MangaUpdatesClient => {
  const fetcher = options.fetcher ?? defaultFetcher;
  const endpoint = (options.endpoint ?? `${MANGAUPDATES_API_ORIGIN}/v1`).replace(/\/$/, "");

  const request = async (path: string, method = "GET", body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": MANGAUPDATES_USER_AGENT,
    };
    if (body !== undefined) {headers["content-type"] = "application/json";}
    const response = await fetcher(`${endpoint}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw errorFrom(`MangaUpdates returned HTTP ${response.status}`, response.status);
    }
    return response;
  };

  const requestJson = async (path: string, method = "GET", body?: unknown): Promise<unknown> =>
    // SAFETY: test/double or boundary cast through unknown to Promise<unknown>
    (await request(path, method, body)).json() as Promise<unknown>;

  return {
    search: (query) =>
      // SAFETY: value matches Promise<readonly MangaUpdatesSeries[]> at this call site
      withSourceError(async () => {
        const normalized = query.trim();
        if (!normalized) {throw errorFrom("MangaUpdates search query cannot be empty");}
        const body = await requestJson("/series/search", "POST", {
          search: normalized,
          perpage: 25,
          page: 1,
        });
        const rec = record(body);
        const results = Array.isArray(rec?.results) ? rec.results : [];
        return results
          .map(seriesFromRecord)
          .filter((m): m is MangaUpdatesSeries => m !== undefined);
      }) as Promise<readonly MangaUpdatesSeries[]>,
    getSeries: (id) =>
      // SAFETY: value matches Promise<MangaUpdatesSeries> at this call site
      withSourceError(async () => {
        const body = await requestJson(`/series/${encodeURIComponent(String(id))}`, "GET");
        const series = seriesFromRecord(body);
        if (!series) {throw errorFrom(`MangaUpdates series not found: ${id}`, 404);}
        return series;
      }) as Promise<MangaUpdatesSeries>,
    releases: (releaseOptions) =>
      // SAFETY: value matches Promise<MangaUpdatesPaged<MangaUpdatesRelease>> at this call site
      withSourceError(async () => {
        const page = releaseOptions.page ?? 1;
        const perpage = releaseOptions.perpage ?? 50;
        const body = await requestJson(`/releases/search`, "POST", {
          search: releaseOptions.search ?? "",
          page,
          perpage,
          ...(releaseOptions.orderby ? { orderby: releaseOptions.orderby } : { orderby: "date" }),
        });
        const rec = record(body);
        const results = Array.isArray(rec?.results) ? rec.results : [];
        const items = results.map(releaseFromRecord).filter((r): r is MangaUpdatesRelease => r !== undefined);
        return { items, total: numberValue(rec?.total_hits ?? rec?.total) ?? items.length };
      }) as Promise<MangaUpdatesPaged<MangaUpdatesRelease>>,
  };
};
