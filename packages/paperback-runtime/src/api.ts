import type {
  CanonicalEntry,
  CanonicalListState,
  CanonicalListStateChange,
  CanonicalSearchResult,
} from "@manifold/canonical";
import {
  CanonicalIdentity,
  type CanonicalIdentity as CanonicalIdentityBody,
  CanonicalSearchResponse,
  CompleteOpsInput,
  decodeResponse,
  EntryByProviderResponse,
  ListState,
  ListStateResponse,
  MangaDexFeedPage,
  MangaDexLibraryResponse,
  MangaDexMatchResult,
  OkResponse,
  OpsListResponse,
  ProgressResponse,
  ReadingProgress,
  RecordedCountResponse,
  RecordReadInput,
  RegistryEntriesResponse,
  RegistryEntry,
  type RegistryProvider,
  ReportUpdateFailuresInput,
  UpdatedCountResponse,
  UpdateProbeFailureInput,
  type UpdateProbeReason,
  type UpdateProbeSource,
} from "@manifold/contract";
import {
  isJsonObject,
  isString,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import { Schema } from "effect";

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
  readonly body: JsonValue;
};

export type PersonalApiRequester = (
  request: PersonalApiRequest,
) => Promise<PersonalApiResponse>;

/** Registry UUID row (HTTP). Prefer this name; PersonalEntry is a compat alias. */
export type PersonalEntry = RegistryEntry;
export type PersonalProviderLink = RegistryEntry["providers"][number];
export type PersonalReadingProgress = ReadingProgress;
export type PersonalReadInput = RecordReadInput;
export type PersonalMangaDexLibraryItem = {
  readonly mangaDexId: string;
  readonly status: string;
  readonly entryId: string | null;
};
export type PersonalFeedChapter = {
  readonly id: string;
  readonly mangaId: string;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly title?: string;
  readonly publishedAt?: number;
  readonly language?: string;
};

export type RegistryResolveInput = {
  readonly provider: RegistryProvider;
  readonly providerId: string;
  readonly title: string;
};

/** Subset of SyncOp the device drain path needs. */
export type PendingSyncOp = {
  readonly opId: string;
  readonly kind: string;
  readonly origin: string;
  readonly payload: JsonObject;
  readonly attempts: number;
};

export type { MangaDexMatchResult };
export type MangaDexMatchCandidate = MangaDexMatchResult["candidates"][number];

export type { UpdateProbeSource, UpdateProbeReason };
export type { UpdateProbeFailureInput };

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
    link: {
      readonly provider: "mangadex" | "comix";
      readonly externalId: string;
      readonly title?: string;
    },
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
  /** Registry row linked to a MangaDex id (not a search identity). */
  readonly entryByMangaDex: (mangaDexId: string) => Promise<PersonalEntry | undefined>;
  readonly resolveEntry: (input: RegistryResolveInput) => Promise<PersonalEntry>;
  readonly resolveEntries: (
    inputs: readonly RegistryResolveInput[],
  ) => Promise<readonly PersonalEntry[]>;
  readonly getListState: (entryId: string) => Promise<CanonicalListState | undefined>;
  readonly setListState: (
    entryId: string,
    change: CanonicalListStateChange,
  ) => Promise<CanonicalListState>;
  readonly nukeEntry: (entryId: string) => Promise<void>;
  readonly pendingAniListOps: (limit?: number) => Promise<readonly PendingSyncOp[]>;
  readonly completeOps: (
    results: readonly {
      readonly opId: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly mediaListEntryId?: number;
    }[],
  ) => Promise<{ updated: number }>;
  readonly reportUpdateFailures: (
    failures: readonly UpdateProbeFailureInput[],
  ) => Promise<{ recorded: number }>;
}

type PersonalApiPostBody =
  | JsonValue
  | CanonicalEntry
  | PersonalReadInput
  | CanonicalListStateChange
  | { readonly failures: readonly UpdateProbeFailureInput[] }
  | { readonly results: CompleteOpsInput["results"] }
  | { readonly status: string | null }
  | { readonly origin: "device" }
  | {
      readonly provider: string;
      readonly externalId: string;
      readonly title?: string;
    }
  | {
      readonly id: string;
      readonly provider: string;
      readonly providerId: string;
      readonly title: string;
    }
  | {
      readonly provider: string;
      readonly providerId: string;
      readonly title: string;
    }
  | readonly {
      readonly provider: string;
      readonly providerId: string;
      readonly title: string;
    }[];

export class PersonalApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PersonalApiError";
    this.status = status;
  }
}

const asErrorMessage = (body: JsonValue, status: number): string => {
  const error = isJsonObject(body) ? body.error : undefined;
  return isString(error) ? error : `Personal API returned HTTP ${status}`;
};

const limitValue = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(25, Math.max(1, Math.floor(limit)));
};

const listStateFromContract = (state: ListState): CanonicalListState => ({
  entryId: state.entryId,
  updatedAt: state.updatedAt,
  ...(state.status !== undefined && { status: state.status }),
  ...(state.score !== undefined && { score: state.score }),
  ...(state.notes !== undefined && { notes: state.notes }),
  ...(state.startedAt !== undefined && { startedAt: state.startedAt }),
  ...(state.completedAt !== undefined && { completedAt: state.completedAt }),
  ...(state.volumeProgress !== undefined && { volumeProgress: state.volumeProgress }),
  ...(state.mediaListEntryId !== undefined && { mediaListEntryId: state.mediaListEntryId }),
});

const identityToCanonical = (value: CanonicalIdentityBody): CanonicalEntry => ({
  id: value.id,
  provider: value.provider,
  providerId: value.providerId,
  title: value.title,
  aliases: value.aliases,
  ...(value.externalIds !== undefined && { externalIds: value.externalIds }),
  ...(value.metadata !== undefined && { metadata: value.metadata }),
});

const requireDecoded = <T>(
  schema: Schema.ConstraintDecoder<T>,
  body: unknown,
  label: string,
): T => {
  const decoded = decodeResponse(schema, body, label);
  if (decoded === undefined) {
    throw new PersonalApiError(`Personal API response failed schema decode (${label})`, 502);
  }
  return decoded;
};

export const createPersonalApiClient = (
  requester: PersonalApiRequester,
  options: { readonly origin?: string; readonly token: string },
): PersonalApiClient => {
  const origin = (options.origin ?? MANIFOLD_API_ORIGIN).replace(/\/$/, "");

  const rawRequest = async (
    path: string,
    method = "GET",
    body?: PersonalApiPostBody,
  ): Promise<PersonalApiResponse> => {
    const response = await requester({
      url: `${origin}${path}`,
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
        ...(!(body === undefined) && { "content-type": "application/json" }),
      },
      ...(!(body === undefined) && { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new PersonalApiError(asErrorMessage(response.body, response.status), response.status);
    }
    return response;
  };

  return {
    searchCanonical: async (query, limit, provider = "anilist") => {
      const params = [
        `q=${encodeURIComponent(query.trim())}`,
        `provider=${encodeURIComponent(provider)}`,
        `limit=${encodeURIComponent(String(limitValue(limit)))}`,
      ].join("&");
      const response = await rawRequest(`/v1/canonical/search?${params}`);
      const body = decodeResponse(CanonicalSearchResponse, response.body, "canonical.search");
      if (body === undefined) {
        return { query: query.trim(), results: [] };
      }
      return {
        query: body.query,
        results: body.results.map((hit) => ({
          id: hit.id,
          provider: hit.provider,
          providerId: hit.providerId,
          title: hit.title,
          aliases: hit.aliases,
          score: hit.score,
          ...(hit.externalIds !== undefined && { externalIds: hit.externalIds }),
          ...(hit.metadata !== undefined && { metadata: hit.metadata }),
        })),
      };
    },

    getCanonical: async (provider, providerId) => {
      try {
        const response = await rawRequest(
          `/v1/canonical/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}`,
        );
        const body = decodeResponse(CanonicalIdentity, response.body, "canonical.get");
        return body === undefined ? undefined : identityToCanonical(body);
      } catch (error) {
        if (error instanceof PersonalApiError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    },

    getEntry: async (entryId) => {
      try {
        const response = await rawRequest(`/v1/entries/${encodeURIComponent(entryId)}`);
        return decodeResponse(RegistryEntry, response.body, "entries.get");
      } catch (error) {
        if (error instanceof PersonalApiError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    },

    upsertEntry: async (entry) => {
      const response = await rawRequest("/v1/entries", "POST", {
        id: entry.id,
        provider: entry.provider,
        providerId: entry.providerId,
        title: entry.title,
      });
      return requireDecoded(RegistryEntry, response.body, "entries.upsert");
    },

    linkProvider: async (entryId, link) => {
      const response = await rawRequest(
        `/v1/entries/${encodeURIComponent(entryId)}/providers`,
        "POST",
        link,
      );
      return requireDecoded(RegistryEntry, response.body, "entries.linkProvider");
    },

    resolveMangaDex: async (entry) => {
      const response = await rawRequest("/v1/canonical/mangadex/resolve", "POST", {
        id: entry.id,
        provider: entry.provider === "local" ? "anilist" : entry.provider,
        providerId: entry.providerId,
        title: entry.title,
        aliases: entry.aliases,
        ...(entry.externalIds !== undefined && { externalIds: entry.externalIds }),
        ...(entry.metadata !== undefined && {
          metadata: {
            ...(entry.metadata.chapters !== undefined && { chapters: entry.metadata.chapters }),
            ...(entry.metadata.volumes !== undefined && { volumes: entry.metadata.volumes }),
            ...(entry.metadata.startDate !== undefined && { startDate: entry.metadata.startDate }),
            ...(entry.metadata.endDate !== undefined && { endDate: entry.metadata.endDate }),
            ...(entry.metadata.status !== undefined && { status: entry.metadata.status }),
          },
        }),
      });
      return requireDecoded(MangaDexMatchResult, response.body, "canonical.mangadex.resolve");
    },

    getProgress: async (entryId) => {
      const response = await rawRequest(`/v1/entries/${encodeURIComponent(entryId)}/progress`);
      const body = decodeResponse(ProgressResponse, response.body, "entries.progress");
      if (body === undefined || body.progress === null) {
        return undefined;
      }
      return body.progress;
    },

    recordRead: async (entryId, input) => {
      const response = await rawRequest(
        `/v1/entries/${encodeURIComponent(entryId)}/read`,
        "POST",
        input,
      );
      return requireDecoded(ReadingProgress, response.body, "entries.read");
    },

    mangaDexLibrary: async () => {
      const response = await rawRequest("/v1/mangadex/library");
      const body = decodeResponse(MangaDexLibraryResponse, response.body, "mangadex.library");
      if (body === undefined) {
        return [];
      }
      return body.library.map((item) => ({
        mangaDexId: item.mangaDexId,
        status: item.status,
        entryId: item.entryId,
      }));
    },

    mangaDexFeed: async (limit, offset) => {
      const response = await rawRequest(`/v1/mangadex/feed?limit=${limit}&offset=${offset}`);
      const body = decodeResponse(MangaDexFeedPage, response.body, "mangadex.feed");
      if (body === undefined) {
        return { items: [] };
      }
      return {
        items: body.items.map((item) => ({
          id: item.id,
          mangaId: item.mangaId,
          language: item.language,
          ...(item.chapterNumber !== undefined && { chapterNumber: item.chapterNumber }),
          ...(item.volumeNumber !== undefined && { volumeNumber: item.volumeNumber }),
          ...(item.title !== undefined && { title: item.title }),
          ...(item.publishedAt !== undefined && { publishedAt: item.publishedAt }),
        })),
        ...(body.total !== undefined && { total: body.total }),
      };
    },

    setMangaDexStatus: async (mangaDexId, status) => {
      const response = await rawRequest(
        `/v1/mangadex/status/${encodeURIComponent(mangaDexId)}`,
        "POST",
        { status },
      );
      requireDecoded(OkResponse, response.body, "mangadex.status");
    },

    entryByMangaDex: async (mangaDexId) => {
      const response = await rawRequest(
        `/v1/canonical/by-provider/mangadex/${encodeURIComponent(mangaDexId)}`,
      );
      const body = decodeResponse(EntryByProviderResponse, response.body, "canonical.byProvider");
      if (body === undefined || body.entry === null) {
        return undefined;
      }
      return body.entry;
    },

    resolveEntry: async (input) => {
      const response = await rawRequest("/v1/canonical/resolve", "POST", {
        provider: input.provider,
        providerId: input.providerId,
        title: input.title,
      });
      return requireDecoded(RegistryEntry, response.body, "canonical.resolve");
    },

    resolveEntries: async (inputs) => {
      const response = await rawRequest(
        "/v1/canonical/resolve-batch",
        "POST",
        inputs.map((input) => ({
          provider: input.provider,
          providerId: input.providerId,
          title: input.title,
        })),
      );
      const body = decodeResponse(RegistryEntriesResponse, response.body, "canonical.resolveBatch");
      return body === undefined ? [] : body.entries;
    },

    getListState: async (entryId) => {
      const response = await rawRequest(`/v1/entries/${encodeURIComponent(entryId)}/list-state`);
      const body = decodeResponse(ListStateResponse, response.body, "entries.listState.get");
      if (body === undefined || body.state === null) {
        return undefined;
      }
      return listStateFromContract(body.state);
    },

    setListState: async (entryId, change) => {
      const response = await rawRequest(
        `/v1/entries/${encodeURIComponent(entryId)}/list-state`,
        "POST",
        change,
      );
      const state = requireDecoded(ListState, response.body, "entries.listState.set");
      return listStateFromContract(state);
    },

    nukeEntry: async (entryId) => {
      await rawRequest(`/v1/entries/${encodeURIComponent(entryId)}/delete`, "POST", {
        origin: "device",
      });
    },

    pendingAniListOps: async (limit = 25) => {
      const response = await rawRequest(
        `/v1/ops/pending/anilist?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`,
      );
      const body = decodeResponse(OpsListResponse, response.body, "ops.pending.anilist");
      if (body === undefined) {
        return [];
      }
      return body.ops.map((op) => ({
        opId: op.opId,
        kind: op.kind,
        origin: op.origin,
        payload: op.payload,
        attempts: op.attempts,
      }));
    },

    completeOps: async (results) => {
      const response = await rawRequest("/v1/ops/complete", "POST", { results });
      const body = decodeResponse(UpdatedCountResponse, response.body, "ops.complete");
      return body ?? { updated: 0 };
    },

    reportUpdateFailures: async (failures) => {
      if (failures.length === 0) {
        return { recorded: 0 };
      }
      const response = await rawRequest("/v1/update-failures", "POST", {
        failures: failures.slice(0, 100).map((failure) => ({
          title: failure.title,
          source: failure.source,
          reason: failure.reason,
          ...(failure.entryId !== undefined &&
            failure.entryId.length > 0 && { entryId: failure.entryId }),
          ...(failure.detail !== undefined &&
            failure.detail.length > 0 && { detail: failure.detail }),
        })),
      });
      const body = decodeResponse(RecordedCountResponse, response.body, "updateFailures.report");
      return body ?? { recorded: 0 };
    },
  };
};
