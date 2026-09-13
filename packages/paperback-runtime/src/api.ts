/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
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
  type IngestCandidateInput,
  ListState,
  ListStateResponse,
  MangaDexFeedPage,
  MangaDexLibraryResponse,
  MangaDexMatchResult,
  OkResponse,
  OpsListResponse,
  ProgressResponse,
  ReadingProgress,
  RecordReadInput,
  RegistryEntriesResponse,
  RegistryEntry,
  RegistryListResponse,
  type RegistryListEntry,
  type RegistryProvider,
  UpdatedCountResponse,
} from "@manifold/contract";
import {
  arrayField,
  isJsonObject,
  isString,
  objectField,
  stringField,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import { Data, Effect, Schema } from "effect";
import { fromPromise } from "./from-promise.js";
import { PaperbackRuntimeError } from "./errors.js";

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

export type PersonalApiRequester = (request: PersonalApiRequest) => Promise<PersonalApiResponse>;

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

export interface PersonalApiClient {
  readonly searchCanonical: (
    query: string,
    limit?: number,
    provider?: "auto" | "all" | "anilist" | "mal",
  ) => Promise<{
    readonly query: string;
    readonly results: readonly CanonicalSearchResult[];
  }>;
  readonly getRegistryCanonical: (entryId: string) => Promise<CanonicalEntry>;
  readonly getEntry: (entryId: string) => Promise<PersonalEntry | undefined>;
  readonly searchRegistry: (query: string, limit?: number) => Promise<readonly PersonalEntry[]>;
  readonly listRegistry: (limit?: number, offset?: number) => Promise<readonly RegistryListEntry[]>;
  readonly ingestCandidate: (input: IngestCandidateInput) => Promise<PersonalEntry>;
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
  readonly setMangaDexStatus: (mangaDexId: string, status: string | null) => Promise<void>;
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
}

type PersonalApiPostBody =
  | JsonValue
  | CanonicalEntry
  | PersonalReadInput
  | CanonicalListStateChange
  | { readonly results: CompleteOpsInput["results"] }
  | { readonly status: string | null }
  | { readonly origin: "device" }
  | IngestCandidateInput
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

export class PersonalApiError extends Data.TaggedError("PersonalApiError")<{
  readonly message: string;
  readonly status: number;
}> {}

const asErrorMessage = (body: JsonValue, status: number): string => {
  const error = isJsonObject(body) ? body.error : undefined;
  if (isString(error)) {
    return error;
  }
  const providers = isJsonObject(body) ? arrayField(body, "providers") : undefined;
  const failures = (providers ?? []).flatMap((provider) => {
    const failure = isJsonObject(provider) ? objectField(provider, "error") : undefined;
    const message = failure ? stringField(failure, "message") : undefined;
    return message ? [message] : [];
  });
  return failures.join("; ") || `Personal API returned HTTP ${status}`;
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
  body: JsonValue,
  label: string,
): Effect.Effect<T, PersonalApiError> =>
  Effect.try({
    try: () => decodeResponse(schema, body, label),
    catch: () =>
      new PersonalApiError({
        message: `Personal API response failed schema decode (${label})`,
        status: 502,
      }),
  });

const isPersonalApiError = (cause: unknown): cause is PersonalApiError =>
  cause instanceof PersonalApiError;

/** Map PersonalApiError 404 → succeed undefined; rethrow other failures. */
const undefinedOn404 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (cause): cause is PersonalApiError & E => isPersonalApiError(cause) && cause.status === 404,
      // SAFETY: 404 maps to absent resource; callers expect A | undefined
      (): Effect.Effect<A | undefined, never, never> => Effect.as(Effect.void, undefined),
    ),
  );

export const createPersonalApiClient = (
  requester: PersonalApiRequester,
  options: { readonly origin?: string; readonly token: string },
): PersonalApiClient => {
  const origin = (options.origin ?? MANIFOLD_API_ORIGIN).replace(/\/$/, "");

  const rawRequestEffect = (
    path: string,
    method = "GET",
    body?: PersonalApiPostBody,
  ): Effect.Effect<PersonalApiResponse, PersonalApiError | PaperbackRuntimeError> =>
    Effect.gen(function* () {
      const response = yield* fromPromise(() =>
        requester({
          url: `${origin}${path}`,
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.token}`,
            ...(!(body === undefined) && { "content-type": "application/json" }),
          },
          ...(!(body === undefined) && { body: JSON.stringify(body) }),
        }),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new PersonalApiError({
          message: asErrorMessage(response.body, response.status),
          status: response.status,
        });
      }
      return response;
    });

  return {
    searchCanonical: (query, limit, provider = "auto") =>
      Effect.runPromise(
        Effect.gen(function* () {
          const params = [
            `q=${encodeURIComponent(query.trim())}`,
            `provider=${encodeURIComponent(provider)}`,
            `limit=${encodeURIComponent(String(limitValue(limit)))}`,
          ].join("&");
          const response = yield* rawRequestEffect(`/v1/canonical/search?${params}`);
          const body = yield* requireDecoded(
            CanonicalSearchResponse,
            response.body,
            "canonical.search",
          );
          for (const source of body.providers) {
            if (source.error) {
              yield* Effect.logWarning(
                `[manifold] ${source.provider} search: ${source.error.message}`,
              );
            }
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
        }),
      ),

    getCanonical: (provider, providerId) =>
      Effect.runPromise(
        undefinedOn404(
          Effect.gen(function* () {
            const response = yield* rawRequestEffect(
              `/v1/canonical/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}`,
            );
            const body = yield* requireDecoded(CanonicalIdentity, response.body, "canonical.get");
            return identityToCanonical(body);
          }),
        ),
      ),

    getRegistryCanonical: (entryId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/entries/${encodeURIComponent(entryId)}/canonical`,
          );
          const body = yield* requireDecoded(CanonicalIdentity, response.body, "entries.canonical");
          return identityToCanonical(body);
        }),
      ),

    getEntry: (entryId) =>
      Effect.runPromise(
        undefinedOn404(
          Effect.gen(function* () {
            const response = yield* rawRequestEffect(`/v1/entries/${encodeURIComponent(entryId)}`);
            return yield* requireDecoded(RegistryEntry, response.body, "entries.get");
          }),
        ),
      ),

    searchRegistry: (query, limit = 25) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const params = [
            `q=${encodeURIComponent(query.trim())}`,
            `limit=${encodeURIComponent(String(limitValue(limit)))}`,
          ].join("&");
          const response = yield* rawRequestEffect(`/v1/registry/search?${params}`);
          return (yield* requireDecoded(RegistryEntriesResponse, response.body, "registry.search"))
            .entries;
        }),
      ),

    listRegistry: (limit = 500, offset = 0) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)));
          const safeOffset = Math.max(0, Math.floor(offset));
          const response = yield* rawRequestEffect(
            `/v1/registry?limit=${safeLimit}&offset=${safeOffset}`,
          );
          return (yield* requireDecoded(RegistryListResponse, response.body, "registry.list"))
            .entries;
        }),
      ),

    ingestCandidate: (input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect("/v1/registry/ingest", "POST", input);
          return yield* requireDecoded(RegistryEntry, response.body, "registry.ingest");
        }),
      ),

    upsertEntry: (entry) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect("/v1/entries", "POST", {
            id: entry.id,
            provider: entry.provider,
            providerId: entry.providerId,
            title: entry.title,
          });
          return yield* requireDecoded(RegistryEntry, response.body, "entries.upsert");
        }),
      ),

    linkProvider: (entryId, link) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/entries/${encodeURIComponent(entryId)}/providers`,
            "POST",
            link,
          );
          return yield* requireDecoded(RegistryEntry, response.body, "entries.linkProvider");
        }),
      ),

    resolveMangaDex: (entry) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect("/v1/canonical/mangadex/resolve", "POST", {
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
                ...(entry.metadata.startDate !== undefined && {
                  startDate: entry.metadata.startDate,
                }),
                ...(entry.metadata.endDate !== undefined && { endDate: entry.metadata.endDate }),
                ...(entry.metadata.status !== undefined && { status: entry.metadata.status }),
              },
            }),
          });
          return yield* requireDecoded(
            MangaDexMatchResult,
            response.body,
            "canonical.mangadex.resolve",
          );
        }),
      ),

    getProgress: (entryId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/entries/${encodeURIComponent(entryId)}/progress`,
          );
          const body = yield* requireDecoded(ProgressResponse, response.body, "entries.progress");
          if (body.progress === null) {
            return undefined;
          }
          return body.progress;
        }),
      ),

    recordRead: (entryId, input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/entries/${encodeURIComponent(entryId)}/read`,
            "POST",
            input,
          );
          return yield* requireDecoded(ReadingProgress, response.body, "entries.read");
        }),
      ),

    mangaDexLibrary: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect("/v1/mangadex/library");
          const body = yield* requireDecoded(
            MangaDexLibraryResponse,
            response.body,
            "mangadex.library",
          );
          return body.library.map((item) => ({
            mangaDexId: item.mangaDexId,
            status: item.status,
            entryId: item.entryId,
          }));
        }),
      ),

    mangaDexFeed: (limit, offset) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/mangadex/feed?limit=${limit}&offset=${offset}`,
          );
          const body = yield* requireDecoded(MangaDexFeedPage, response.body, "mangadex.feed");
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
        }),
      ),

    setMangaDexStatus: (mangaDexId, status) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/mangadex/status/${encodeURIComponent(mangaDexId)}`,
            "POST",
            { status },
          );
          yield* requireDecoded(OkResponse, response.body, "mangadex.status");
        }),
      ),

    entryByMangaDex: (mangaDexId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/canonical/by-provider/mangadex/${encodeURIComponent(mangaDexId)}`,
          );
          const body = yield* requireDecoded(
            EntryByProviderResponse,
            response.body,
            "canonical.byProvider",
          );
          if (body.entry === null) {
            return undefined;
          }
          return body.entry;
        }),
      ),

    resolveEntry: (input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect("/v1/canonical/resolve", "POST", {
            provider: input.provider,
            providerId: input.providerId,
            title: input.title,
          });
          return yield* requireDecoded(RegistryEntry, response.body, "canonical.resolve");
        }),
      ),

    resolveEntries: (inputs) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            "/v1/canonical/resolve-batch",
            "POST",
            inputs.map((input) => ({
              provider: input.provider,
              providerId: input.providerId,
              title: input.title,
            })),
          );
          const body = yield* requireDecoded(
            RegistryEntriesResponse,
            response.body,
            "canonical.resolveBatch",
          );
          return body.entries;
        }),
      ),

    getListState: (entryId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/entries/${encodeURIComponent(entryId)}/list-state`,
          );
          const body = yield* requireDecoded(
            ListStateResponse,
            response.body,
            "entries.listState.get",
          );
          if (body.state === null) {
            return undefined;
          }
          return listStateFromContract(body.state);
        }),
      ),

    setListState: (entryId, change) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/entries/${encodeURIComponent(entryId)}/list-state`,
            "POST",
            change,
          );
          const state = yield* requireDecoded(ListState, response.body, "entries.listState.set");
          return listStateFromContract(state);
        }),
      ),

    nukeEntry: (entryId) =>
      Effect.runPromise(
        rawRequestEffect(`/v1/entries/${encodeURIComponent(entryId)}/delete`, "POST", {
          origin: "device",
        }).pipe(Effect.asVoid),
      ),

    pendingAniListOps: (limit = 25) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect(
            `/v1/ops/pending/anilist?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`,
          );
          const body = yield* requireDecoded(OpsListResponse, response.body, "ops.pending.anilist");
          return body.ops.map((op) => ({
            opId: op.opId,
            kind: op.kind,
            origin: op.origin,
            payload: op.payload,
            attempts: op.attempts,
          }));
        }),
      ),

    completeOps: (results) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* rawRequestEffect("/v1/ops/complete", "POST", { results });
          return yield* requireDecoded(UpdatedCountResponse, response.body, "ops.complete");
        }),
      ),
  };
};
