import type {
  CanonicalEntry,
  CanonicalListState,
  CanonicalListStateChange,
  CanonicalSearchResult
} from "@manifold/canonical";

export const MANIFOLD_API_ORIGIN = "https://manifold.jfa.dev/api";
export const MANIFOLD_API_TOKEN_KEY = "manifold.api-token";
export const MANIFOLD_API_STATUS_KEY = "manifold.api-token-status";

export type PersonalApiRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
};

export type PersonalApiResponse = {
  readonly status: number;
  readonly body: unknown;
};

export type PersonalApiRequester = (
  request: PersonalApiRequest,
) => Promise<PersonalApiResponse>;

export interface PersonalProviderLink {
  readonly provider: "anilist" | "mal" | "mangadex" | "comix";
  readonly externalId: string;
  readonly title?: string;
  readonly updatedAt: number;
}

export interface RegistryResolveInput {
  readonly provider: "anilist" | "mal" | "mangadex" | "comix";
  readonly providerId: string;
  readonly title: string;
}

export interface PendingSyncOp {
  readonly opId: string;
  readonly kind: string;
  readonly origin: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

export interface MangaDexMatchCandidate {
  readonly externalId: string;
  readonly title: string;
  readonly score: number;
  readonly anilistId?: string;
  readonly myAnimeListId?: string;
}

export interface MangaDexMatchResult {
  readonly canonicalId: string;
  readonly status: "matched" | "ambiguous" | "not_found";
  readonly candidates: readonly MangaDexMatchCandidate[];
  readonly externalId?: string;
  readonly title?: string;
  readonly method?: "cached" | "anilist-link" | "mal-link" | "vectorize";
  readonly score?: number;
  readonly margin?: number;
}

export interface PersonalEntry {
  readonly id: string;
  readonly provider: "anilist" | "mal" | "local";
  readonly providerId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providers: readonly PersonalProviderLink[];
}

export interface PersonalReadingProgress {
  readonly entryId: string;
  readonly chapterKey: string;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly provider?: "mangadex" | "comix";
  readonly sourceChapterId?: string;
  readonly readAt: number;
  readonly version: number;
}

export interface PersonalReadInput {
  readonly eventId?: string;
  readonly chapterKey: string;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly provider?: "mangadex" | "comix";
  readonly sourceChapterId?: string;
  readonly readAt?: number;
}

export interface PersonalMangaDexLibraryItem {
  readonly mangaDexId: string;
  readonly status: string;
  readonly entryId: string | null;
}

export interface PersonalFeedChapter {
  readonly id: string;
  readonly mangaId: string;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly title?: string;
  readonly publishedAt?: number;
}

export interface PersonalApiClient {
  readonly searchCanonical: (
    query: string,
    limit?: number,
    provider?: "all" | "anilist" | "mal",
  ) => Promise<{
    readonly query: string;
    readonly results: readonly CanonicalSearchResult[];
  }>;
  readonly getEntry: (entryId: string) => Promise<PersonalEntry | undefined>;
  readonly upsertEntry: (
    entry: Pick<CanonicalSearchResult, "id" | "provider" | "providerId" | "title">,
  ) => Promise<PersonalEntry>;
  readonly linkProvider: (
    entryId: string,
    link: { readonly provider: "mangadex" | "comix"; readonly externalId: string; readonly title?: string },
  ) => Promise<PersonalEntry>;
  readonly getCanonical: (
    provider: "anilist" | "mal",
    providerId: string,
  ) => Promise<CanonicalEntry | undefined>;
  readonly resolveMangaDex: (entry: CanonicalEntry) => Promise<MangaDexMatchResult>;
  readonly getProgress: (entryId: string) => Promise<PersonalReadingProgress | undefined>;
  readonly recordRead: (
    entryId: string,
    input: PersonalReadInput,
  ) => Promise<PersonalReadingProgress>;
  readonly mangaDexLibrary: () => Promise<readonly PersonalMangaDexLibraryItem[]>;
  readonly mangaDexFeed: (
    limit: number,
    offset: number,
  ) => Promise<{
    readonly items: readonly (PersonalFeedChapter & { readonly language: string })[];
    readonly total?: number;
  }>;
  readonly setMangaDexStatus: (
    mangaDexId: string,
    status: string | null,
  ) => Promise<void>;
  readonly entryByMangaDex: (mangaDexId: string) => Promise<CanonicalEntry | undefined>;
  // Registry: lazy-mint provider-neutral UUID rows.
  readonly resolveEntry: (input: RegistryResolveInput) => Promise<PersonalEntry>;
  readonly resolveEntries: (
    inputs: readonly RegistryResolveInput[],
  ) => Promise<readonly PersonalEntry[]>;
  // List state: the registry owns status/score/notes/dates; AniList mirrors.
  readonly getListState: (entryId: string) => Promise<CanonicalListState | undefined>;
  readonly setListState: (
    entryId: string,
    change: CanonicalListStateChange,
  ) => Promise<CanonicalListState>;
  readonly nukeEntry: (entryId: string) => Promise<void>;
  // Op log drain: the device executes pending anilist ops on its own IP.
  readonly pendingAniListOps: (limit?: number) => Promise<readonly PendingSyncOp[]>;
  readonly completeOps: (
    results: readonly {
      readonly opId: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly mediaListEntryId?: number;
    }[],
  ) => Promise<{ updated: number }>;
}

export class PersonalApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PersonalApiError";
    this.status = status;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asErrorMessage = (body: unknown, status: number): string => {
  const record = asRecord(body);
  return typeof record?.error === "string"
    ? record.error
    : `Personal API returned HTTP ${status}`;
};

const limitValue = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  return Math.min(25, Math.max(1, Math.floor(limit)));
};

export const createPersonalApiClient = (
  requester: PersonalApiRequester,
  options: { readonly origin?: string; readonly token: string },
): PersonalApiClient => {
  const origin = (options.origin ?? MANIFOLD_API_ORIGIN).replace(/\/$/, "");
  const request = async <A>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<A> => {
    const response = await requester({
      url: `${origin}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new PersonalApiError(asErrorMessage(response.body, response.status), response.status);
    }
    return response.body as A;
  };

  return {
    searchCanonical: async (query, limit, provider = "anilist") => {
      const params = [
        `q=${encodeURIComponent(query.trim())}`,
        `provider=${encodeURIComponent(provider)}`,
        `limit=${encodeURIComponent(String(limitValue(limit)))}`,
      ].join("&");
      const body = await request<{
        readonly query: string;
        readonly results: readonly CanonicalSearchResult[];
      }>(`/v1/canonical/search?${params}`);
      return {
        query: body.query,
        results: Array.isArray(body.results) ? body.results : [],
      };
    },
    getCanonical: async (provider, providerId) => {
      try {
        return await request<CanonicalEntry>(
          `/v1/canonical/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}`,
        );
      } catch (error) {
        if (error instanceof PersonalApiError && error.status === 404) return undefined;
        throw error;
      }
    },
    getEntry: async (entryId) => {
      try {
        return await request<PersonalEntry>(`/v1/entries/${encodeURIComponent(entryId)}`);
      } catch (error) {
        if (error instanceof PersonalApiError && error.status === 404) return undefined;
        throw error;
      }
    },
    upsertEntry: (entry) =>
      request<PersonalEntry>("/v1/entries", "POST", {
        id: entry.id,
        provider: entry.provider,
        providerId: entry.providerId,
        title: entry.title,
      }),
    linkProvider: (entryId, link) =>
      request<PersonalEntry>(
        `/v1/entries/${encodeURIComponent(entryId)}/providers`,
        "POST",
        link,
      ),
    resolveMangaDex: (entry) => request<MangaDexMatchResult>(
      "/v1/canonical/mangadex/resolve",
      "POST",
      entry,
    ),
    getProgress: async (entryId) => {
      const body = await request<PersonalReadingProgress | { readonly progress: PersonalReadingProgress | null }>(
        `/v1/entries/${encodeURIComponent(entryId)}/progress`,
      );
      const record = asRecord(body);
      if (record && "progress" in record) {
        return record.progress === null
          ? undefined
          : record.progress as PersonalReadingProgress;
      }
      return body as PersonalReadingProgress;
    },
    recordRead: (entryId, input) => request<PersonalReadingProgress>(
      `/v1/entries/${encodeURIComponent(entryId)}/read`,
      "POST",
      input,
    ),
    mangaDexLibrary: async () => {
      const body = await request<{ readonly library: readonly PersonalMangaDexLibraryItem[] }>(
        "/v1/mangadex/library",
      );
      return Array.isArray(body.library) ? body.library : [];
    },
    mangaDexFeed: async (limit, offset) => {
      const body = await request<{
        readonly items?: readonly PersonalFeedChapter[];
        readonly total?: number;
      }>(`/v1/mangadex/feed?limit=${limit}&offset=${offset}`);
      const items = Array.isArray(body.items) ? body.items : [];
      return {
        items: items.map((item) => ({ ...item, language: "en" })),
        total: body.total,
      };
    },
    setMangaDexStatus: async (mangaDexId, status) => {
      await request(
        `/v1/mangadex/status/${encodeURIComponent(mangaDexId)}`,
        "POST",
        { status },
      );
    },
    entryByMangaDex: async (mangaDexId) => {
      const body = await request<CanonicalEntry | { readonly entry: CanonicalEntry | null }>(
        `/v1/canonical/by-provider/mangadex/${encodeURIComponent(mangaDexId)}`,
      );
      if (body && "entry" in (body as Record<string, unknown>)) {
        return (body as { entry: CanonicalEntry | null }).entry ?? undefined;
      }
      return body as CanonicalEntry;
    },
    resolveEntry: (input) =>
      request<PersonalEntry>("/v1/canonical/resolve", "POST", {
        provider: input.provider,
        providerId: input.providerId,
        title: input.title,
      }),
    resolveEntries: async (inputs) => {
      const body = await request<{ readonly entries: readonly PersonalEntry[] }>(
        "/v1/canonical/resolve-batch",
        "POST",
        inputs.map((input) => ({
          provider: input.provider,
          providerId: input.providerId,
          title: input.title,
        })),
      );
      return Array.isArray(body.entries) ? body.entries : [];
    },
    getListState: async (entryId) => {
      const body = await request<CanonicalListState | { readonly state: CanonicalListState | null }>(
        `/v1/entries/${encodeURIComponent(entryId)}/list-state`,
      );
      if (body && "state" in (body as Record<string, unknown>)) {
        return (body as { state: CanonicalListState | null }).state ?? undefined;
      }
      return body as CanonicalListState;
    },
    setListState: (entryId, change) =>
      request<CanonicalListState>(
        `/v1/entries/${encodeURIComponent(entryId)}/list-state`,
        "POST",
        change,
      ),
    nukeEntry: async (entryId) => {
      await request(`/v1/entries/${encodeURIComponent(entryId)}/delete`, "POST", {
        origin: "device",
      });
    },
    pendingAniListOps: async (limit = 25) => {
      const body = await request<{ readonly ops: readonly PendingSyncOp[] }>(
        `/v1/ops/pending/anilist?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`,
      );
      return Array.isArray(body.ops) ? body.ops : [];
    },
    completeOps: (results) =>
      request<{ updated: number }>("/v1/ops/complete", "POST", { results }),
  };
};
