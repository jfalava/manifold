import {
  AuthConnection as AuthConnectionSchema,
  type AuthConnection as ContractAuthConnection,
  AuthConnectionsResponse,
  AuthDisconnectedResponse,
  type AuthProvider as ContractAuthProvider,
  decodeResponseEffect,
  EventsListResponse,
  ListState,
  MangaDexLibraryResponse,
  MangaDexLibrarySummary as MangaDexLibrarySummarySchema,
  type MangaDexLibrarySummary as ContractMangaDexLibrarySummary,
  MangaDexLibrarySummaryResponse,
  MangaDexStatsResponse,
  OAuthStart,
  OkResponse,
  OkWithListStateResponse,
  OpsListResponse,
  OpsSummary as OpsSummarySchema,
  type OpsSummary as ContractOpsSummary,
  OpsSummaryResponse,
  RegistryEntry as ContractRegistryEntry,
  type RegistryListEntry,
  RegistryListResponse,
  RegistrySummary as RegistrySummarySchema,
  type RegistrySummary as ContractRegistrySummary,
  RegistrySummaryResponse,
  ResponseDecodeError,
  SyncOp,
  type ListEvent,
} from "@manifold/contract";
import { manifoldUserAgent } from "@manifold/json";
import { createServerFn } from "@tanstack/react-start";
import { DateTime, Effect, Option, Schema } from "effect";

import {
  isFunctionValue,
  isJsonObject,
  isJsonValue,
  isStringValue,
  type SecretHandle,
} from "./guards";
import {
  AdminError,
  platformFetch,
  runHost,
  toError,
  tryPromise,
  workersRuntime,
} from "./effect-host";
import type { MangaDexLibraryItem, MangaDexReadingStatus, MangaDexStat } from "./mangadex";
import {
  cachedJsonProgram,
  invalidateCachedJsonProgram,
  type ComputedSnapshot,
} from "./server-cache";

const MANIFOLD_API_ORIGIN = "https://manifold.jfa.dev/api";
const JsonString = Schema.fromJsonString(Schema.Unknown);

// Type aliases (not interfaces) so TanStack Table v9 accepts them as TData.
export type RegistryLink = RegistryListEntry["providers"][number];
export type RegistryListState = NonNullable<RegistryListEntry["state"]>;
export type RegistryEntry = RegistryListEntry;
export type SyncOpItem = SyncOp;
export type ListEventItem = ListEvent;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: secret binding comes from untyped workers env; parsed at I/O boundary
const resolveSecret = Effect.fnUntraced(function* (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Alchemy secret bindings are runtime handles; guards parse them before use
  binding: unknown,
): Effect.fn.Return<string, AdminError> {
  if (isStringValue(binding)) {
    return binding;
  }
  if (isJsonObject(binding)) {
    // SAFETY: binding is validated as JsonObject and SecretHandle shape is owned; narrow to handle type
    const handle = binding as SecretHandle;
    if (isFunctionValue(handle.get)) {
      const value = yield* tryPromise(() => handle.get!());
      return isStringValue(value) ? value : "";
    }
    if (isStringValue(handle.value)) {
      return handle.value;
    }
  }
  return "";
});

const call = Effect.fnUntraced(function* <A>(
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  init?: { readonly method?: string; readonly body?: unknown },
): Effect.fn.Return<A, AdminError | ResponseDecodeError> {
  const { env } = yield* workersRuntime();
  const token = yield* resolveSecret(env.MANIFOLD_TOKEN);
  if (!token) {
    return yield* new AdminError({
      message: "MANIFOLD_TOKEN binding is not configured for the admin app",
    });
  }
  const origin =
    isStringValue(env.MANIFOLD_API_ORIGIN) && env.MANIFOLD_API_ORIGIN !== ""
      ? env.MANIFOLD_API_ORIGIN
      : MANIFOLD_API_ORIGIN;

  // Prefer the SYNC_API service binding: same-zone public-hostname fetches
  // from this worker hit the edge and die with HTTP 522. The router strips
  // its /api mount before forwarding, so over the binding the path must go
  // without it; direct fetch keeps the public shape.
  const binding = env.SYNC_API;
  const url = new URL(`${origin}${path}`);
  const target = binding
    ? new URL(`${url.pathname.replace(/\/api(?=\/|$)/, "")}${url.search}`, url.origin)
    : url;
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: headers are intentionally open dictionary for HTTP; literal values are known evidence
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": manifoldUserAgent("admin"),
  };
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers,
  };
  if (init?.body !== undefined) {
    requestInit.body = yield* Schema.encodeEffect(JsonString)(init.body).pipe(
      Effect.mapError(toError),
    );
  }
  const response = yield* tryPromise<Response>(() =>
    binding ? binding.fetch(new Request(target, requestInit)) : platformFetch(target, requestInit),
  );
  const text = yield* tryPromise<string>(() => response.text());
  const decoded = Schema.decodeOption(JsonString)(text);
  const raw =
    text.length > 0 && Option.isSome(decoded) ? decoded.value : text.length > 0 ? text : undefined;
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    if (isJsonObject(raw) && "error" in raw) {
      message = isStringValue(raw.error)
        ? raw.error
        : yield* Schema.encodeEffect(JsonString)(raw.error).pipe(Effect.mapError(toError));
    }
    return yield* new AdminError({ message });
  }
  if (raw !== undefined && !isJsonValue(raw)) {
    return yield* new AdminError({ message: `Personal API response is not JSON (${path})` });
  }
  const body = raw === undefined ? null : raw;
  return yield* decodeResponseEffect(schema, body, path);
});

export interface LoadRegistryResult {
  readonly entries: readonly RegistryEntry[];
  readonly error?: string;
}

export interface LoadOperationsResult {
  readonly ops: readonly SyncOpItem[];
  readonly events: readonly ListEventItem[];
  readonly errors: {
    readonly ops?: string;
    readonly events?: string;
  };
}

const capture = Effect.fnUntraced(function* <A>(
  label: string,
  action: Effect.Effect<A, AdminError | ResponseDecodeError>,
): Effect.fn.Return<{ ok: true; value: A } | { ok: false; error: string }> {
  return yield* action.pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed({ ok: true, value } as const),
      onFailure: (error) =>
        Effect.logError(`[admin/registry] ${label} failed: ${error.message}`).pipe(
          Effect.as({ ok: false, error: error.message } as const),
        ),
    }),
  );
});

// /v1/registry defaults to LIMIT 500 — page through it so the admin
// always sees the whole registry.
const loadAllEntries = Effect.fnUntraced(function* (): Effect.fn.Return<
  readonly RegistryEntry[],
  AdminError | ResponseDecodeError
> {
  const pageSize = 500;
  const all: RegistryEntry[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = yield* call(
      `/v1/registry?limit=${pageSize}&offset=${offset}`,
      RegistryListResponse,
    );
    all.push(...page.entries);
    if (page.entries.length < pageSize) {
      break;
    }
  }
  return all;
});

const loadRegistryProgram = capture("registry", loadAllEntries()).pipe(
  Effect.map((registry): LoadRegistryResult =>
    registry.ok ? { entries: registry.value } : { entries: [], error: registry.error },
  ),
);

export const loadRegistry = createServerFn({ method: "GET" }).handler(() =>
  runHost(loadRegistryProgram),
);

const loadOperationsProgram = Effect.fnUntraced(
  function* (): Effect.fn.Return<LoadOperationsResult> {
    const [ops, events] = yield* Effect.all(
      [
        capture("ops", call("/v1/ops?limit=200", OpsListResponse)),
        capture("events", call("/v1/events?limit=100", EventsListResponse)),
      ],
      { concurrency: "unbounded" },
    );
    const errors: {
      ops?: string;
      events?: string;
    } = {}; // oxlint-disable-line anti-slop/no-known-value-widening -- SAFETY: errors map starts empty and is populated conditionally; anonymous type is intentionally widened from empty object
    if (!ops.ok) {
      errors.ops = ops.error;
    }
    if (!events.ok) {
      errors.events = events.error;
    }
    return {
      ops: ops.ok ? ops.value.ops : [],
      events: events.ok ? events.value.events : [],
      errors,
    };
  },
);

export const loadOperations = createServerFn({ method: "GET" }).handler(() =>
  runHost(loadOperationsProgram()),
);

export interface ListStatePatch {
  readonly entryId: string;
  readonly status?: string | null;
  readonly score?: number | null;
  readonly notes?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly volumeProgress?: number | null;
}

export const saveListState = createServerFn({ method: "POST" })
  .validator((data: ListStatePatch) => data)
  .handler(({ data }) => {
    const { entryId, ...patch } = data;
    return runHost(
      call(`/v1/entries/${encodeURIComponent(entryId)}/list-state`, ListState, {
        method: "POST",
        body: { ...patch, origin: "admin" },
      }),
    );
  });

interface BindInput {
  readonly entryId: string;
  readonly provider: string;
  readonly externalId: string;
}

export const bindProvider = createServerFn({ method: "POST" })
  .validator((data: BindInput) => data)
  .handler(({ data }) =>
    runHost(
      call(`/v1/entries/${encodeURIComponent(data.entryId)}/providers`, ContractRegistryEntry, {
        method: "POST",
        body: { provider: data.provider, externalId: data.externalId },
      }),
    ),
  );

interface UnlinkInput {
  readonly entryId: string;
  readonly provider: string;
}

export const unlinkProvider = createServerFn({ method: "POST" })
  .validator((data: UnlinkInput) => data)
  .handler(({ data }) =>
    runHost(
      call(
        `/v1/entries/${encodeURIComponent(data.entryId)}/unlink/${data.provider}`,
        ContractRegistryEntry,
        { method: "POST" },
      ),
    ),
  );

export const nukeEntry = createServerFn({ method: "POST" })
  .validator((data: { entryId: string }) => data)
  .handler(({ data }) =>
    runHost(
      call(`/v1/entries/${encodeURIComponent(data.entryId)}/delete`, OkWithListStateResponse, {
        method: "POST",
        body: { origin: "admin" },
      }),
    ),
  );

export const retryOp = createServerFn({ method: "POST" })
  .validator((data: { opId: string }) => data)
  .handler(({ data }) =>
    runHost(call(`/v1/ops/${encodeURIComponent(data.opId)}/retry`, SyncOp, { method: "POST" })),
  );

export const loadMangaDexLibrary = createServerFn({ method: "POST" })
  .validator((data: { status?: MangaDexReadingStatus } | undefined) => data ?? {})
  .handler(({ data }) => {
    const status = data.status;
    const path =
      status === undefined
        ? "/v1/mangadex/library"
        : `/v1/mangadex/library?status=${encodeURIComponent(status)}`;
    return runHost(
      call(path, MangaDexLibraryResponse).pipe(
        Effect.map((body): readonly MangaDexLibraryItem[] =>
          body.library.map((item) => ({
            mangaDexId: item.mangaDexId,
            status: item.status,
            entryId: item.entryId,
            ...(item.title !== undefined && { title: item.title }),
            ...(item.coverUrl !== undefined && { coverUrl: item.coverUrl }),
            ...(item.hasRating !== undefined && { hasRating: item.hasRating }),
            ...(item.rating !== undefined && { rating: item.rating }),
            ...(item.ratingCreatedAt !== undefined && { ratingCreatedAt: item.ratingCreatedAt }),
          })),
        ),
      ),
    );
  });

/**
 * Reading stats for a page slice of the MangaDex library. Entries whose stats
 * are not (yet) computable are simply absent from the response.
 */
export const loadMangaDexStats = createServerFn({ method: "POST" })
  .validator((data: { ids: readonly string[] }) => data)
  .handler(({ data }): Promise<Record<string, MangaDexStat>> => {
    const ids = [...new Set(data.ids)].slice(0, 200);
    if (ids.length === 0) {
      return runHost(Effect.succeed({}));
    }
    return runHost(
      call("/v1/mangadex/stats", MangaDexStatsResponse, {
        method: "POST",
        body: { ids },
      }).pipe(Effect.map((body): Record<string, MangaDexStat> => body.stats)),
    );
  });

/** Pass "unset" to clear the reading status (null on the MangaDex API). */
export const setMangaDexStatus = createServerFn({ method: "POST" })
  .validator((data: { mangaDexId: string; status: MangaDexReadingStatus | "unset" }) => data)
  .handler(({ data }) =>
    runHost(
      call(`/v1/mangadex/status/${data.mangaDexId}`, OkResponse, {
        method: "POST",
        body: { status: data.status === "unset" ? null : data.status },
      }).pipe(Effect.asVoid),
    ),
  );

// ------------------------------------------------------------------
// Dashboard overview
// ------------------------------------------------------------------

/** Providers a canonical entry can be bound to; "full coverage" = all three trackers. */
export const TRACKER_PROVIDERS = ["anilist", "mal", "mangadex"] as const;

export type RegistrySummary = ContractRegistrySummary;
export type OpsSummary = ContractOpsSummary;
export type MangaDexSummary = ContractMangaDexLibrarySummary;

export interface LibraryOverview {
  readonly fetchedAt: string;
  readonly registry: RegistrySummary | null;
  readonly ops: OpsSummary | null;
  readonly mangadex: MangaDexSummary | null;
  readonly errors: readonly string[];
}

const LibraryOverviewSchema = Schema.Struct({
  fetchedAt: Schema.String,
  registry: Schema.NullOr(RegistrySummarySchema),
  ops: Schema.NullOr(OpsSummarySchema),
  mangadex: Schema.NullOr(MangaDexLibrarySummarySchema),
  errors: Schema.Array(Schema.String),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: cache decoder validates the persisted overview before use
const decodeLibraryOverview = (value: unknown): LibraryOverview | undefined => {
  const decoded = Schema.decodeUnknownOption(LibraryOverviewSchema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/**
 * Compact registry / ops / MangaDex-shelf metrics for the Overview page.
 * Hits dedicated summary endpoints so a cold dashboard never pays for full
 * MangaDex title/cover hydration or paging the entire registry over the wire.
 * Result is cached (KV + in-isolate) with stale-while-revalidate — see server-cache.ts.
 */
const libraryOverviewProgram = cachedJsonProgram(
  "library-overview:v2",
  decodeLibraryOverview,
  Effect.fnUntraced(function* (): Effect.fn.Return<ComputedSnapshot<LibraryOverview>, AdminError> {
    const [registry, ops, mangadex] = yield* Effect.all(
      [
        capture(
          "registry",
          call("/v1/registry/summary", RegistrySummaryResponse).pipe(
            Effect.map((body) => body.summary),
          ),
        ),
        capture(
          "ops",
          call("/v1/ops/summary?limit=200", OpsSummaryResponse).pipe(
            Effect.map((body) => body.summary),
          ),
        ),
        capture(
          "mangadex library",
          call("/v1/mangadex/library/summary", MangaDexLibrarySummaryResponse).pipe(
            Effect.map((body) => body.summary),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const errors: string[] = [];
    if (!registry.ok) {
      errors.push(`registry: ${registry.error}`);
    }
    if (!ops.ok) {
      errors.push(`ops: ${ops.error}`);
    }
    if (!mangadex.ok) {
      errors.push(`mangadex library: ${mangadex.error}`);
    }
    const overview: LibraryOverview = {
      fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      registry: registry.ok ? registry.value : null,
      ops: ops.ok ? ops.value : null,
      mangadex: mangadex.ok ? mangadex.value : null,
      errors,
    };
    return { value: overview, cacheable: errors.length === 0 };
  }),
);

export const getLibraryOverview = createServerFn({ method: "GET" }).handler(() =>
  runHost(libraryOverviewProgram),
);

// ------------------------------------------------------------------
// Upstream auth connections (AniList / MAL / MangaDex)
// ------------------------------------------------------------------

export type AuthProvider = ContractAuthProvider;
export type AuthConnection = ContractAuthConnection;

export const AUTH_PROVIDERS = ["anilist", "mal", "mangadex"] as const;

const isAuthProvider = (value: string): value is AuthProvider => {
  for (const provider of AUTH_PROVIDERS) {
    if (provider === value) {
      return true;
    }
  }
  return false;
};

const loadAuthConnectionsProgram = capture(
  "auth connections",
  call("/v1/auth", AuthConnectionsResponse),
).pipe(Effect.map((result): readonly AuthConnection[] => (result.ok ? result.value : [])));

export const loadAuthConnections = createServerFn({ method: "GET" }).handler(() =>
  runHost(loadAuthConnectionsProgram),
);

/**
 * MangaDex password-grant bootstrap. Uses the MANGADEX_* deployment secrets
 * already bound to the sync Worker — never asks the browser for a password.
 * Mints encrypted access/refresh tokens into the personal Durable Object.
 */
export const loginMangaDex = createServerFn({ method: "POST" }).handler(() =>
  runHost(
    call("/v1/auth/mangadex/login", AuthConnectionSchema, { method: "POST" }).pipe(
      Effect.tap(() =>
        Effect.all(
          [
            invalidateCachedJsonProgram("library-overview:v1"),
            invalidateCachedJsonProgram("library-overview:v2"),
          ],
          { concurrency: "unbounded" },
        ),
      ),
    ),
  ),
);

/**
 * MAL only — authorization-code flow works from Worker egress.
 * AniList code exchange returns 403 on CF IPs; use importAniListToken instead.
 */
export const startMalOAuth = createServerFn({ method: "POST" }).handler(() =>
  runHost(
    call(`/v1/auth/mal/start?return=${encodeURIComponent("/admin/credentials")}`, OAuthStart).pipe(
      Effect.flatMap((start) =>
        isStringValue(start.authorizationUrl) && start.authorizationUrl.length > 0
          ? Effect.succeed({ authorizationUrl: start.authorizationUrl })
          : Effect.fail(
              new AdminError({ message: "OAuth start for mal returned no authorization URL" }),
            ),
      ),
    ),
  ),
);

/**
 * Stores a browser-minted AniList access token on the personal DO.
 * Token is obtained via AniList implicit OAuth (the dedicated admin app
 * 50915) or paste; the Worker never calls AniList's token endpoint.
 */
export const importAniListToken = createServerFn({ method: "POST" })
  .validator((data: { accessToken: string; expiresIn?: number }) => data)
  .handler(({ data }) => {
    const accessToken = data.accessToken.trim();
    if (!accessToken) {
      return runHost(Effect.fail(new AdminError({ message: "AniList access token is empty" })));
    }
    return runHost(
      call(
        "/v1/auth/anilist/token",
        AuthConnectionSchema,
        data.expiresIn !== undefined && data.expiresIn > 0
          ? { method: "POST", body: { accessToken, expiresIn: data.expiresIn } }
          : { method: "POST", body: { accessToken } },
      ).pipe(
        Effect.tap(() =>
          Effect.all(
            [
              invalidateCachedJsonProgram("library-overview:v1"),
              invalidateCachedJsonProgram("library-overview:v2"),
            ],
            { concurrency: "unbounded" },
          ),
        ),
      ),
    );
  });

/**
 * AniList client for the admin browser implicit login: the dedicated admin
 * app 50915. Register exactly this redirect on the app (AniList matches it
 * exactly, and allows one per app):
 * https://manifold.jfa.dev/admin/api/anilist/callback
 * App assignment (memory 1067): the Worker/tracker app is 49060 (PIN
 * callback); 49218 is the CLI app (localhost callback) — neither is used
 * here. The authorize URL carries no redirect_uri — AniList uses the app's
 * registered redirect, which lands on /api/anilist/callback to import the
 * hash token.
 */
export const ANILIST_IMPLICIT_CLIENT_ID = "50915";

export const ANILIST_IMPLICIT_CALLBACK_PATH = "/admin/api/anilist/callback";

/** Same shape as tracker OAuthButtonRow (clientId + response_type=token only). */
export const anilistImplicitAuthorizeUrl = (): string =>
  `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(ANILIST_IMPLICIT_CLIENT_ID)}` +
  `&response_type=token`;

export const disconnectAuth = createServerFn({ method: "POST" })
  .validator((data: { provider: AuthProvider }) => data)
  .handler(({ data }) => {
    const provider = data.provider;
    if (!isAuthProvider(provider)) {
      return runHost(
        Effect.fail(new AdminError({ message: `Unknown auth provider: ${String(provider)}` })),
      );
    }
    return runHost(
      call(`/v1/auth/${encodeURIComponent(provider)}`, AuthDisconnectedResponse, {
        method: "DELETE",
      }).pipe(
        Effect.tap(() =>
          Effect.all(
            [
              invalidateCachedJsonProgram("library-overview:v1"),
              invalidateCachedJsonProgram("library-overview:v2"),
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map((): AuthConnection => ({ provider, connected: false })),
      ),
    );
  });
