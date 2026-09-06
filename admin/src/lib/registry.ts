import { createServerFn } from "@tanstack/react-start";
import { Schema } from "effect";
import {
  AuthConnection as AuthConnectionSchema,
  type AuthConnection as ContractAuthConnection,
  AuthConnectionsResponse,
  AuthDisconnectedResponse,
  type AuthProvider as ContractAuthProvider,
  decodeResponse,
  EventsListResponse,
  ListState,
  MangaDexLibraryResponse,
  type MangaDexLibrarySummary as ContractMangaDexLibrarySummary,
  MangaDexLibrarySummaryResponse,
  MangaDexStatsResponse,
  OAuthStart,
  OkResponse,
  OkWithListStateResponse,
  OpsListResponse,
  type OpsSummary as ContractOpsSummary,
  OpsSummaryResponse,
  RegistryEntry as ContractRegistryEntry,
  type RegistryListEntry,
  RegistryListResponse,
  type RegistrySummary as ContractRegistrySummary,
  RegistrySummaryResponse,
  SyncOp,
  type ListEvent,
} from "@manifold/contract";

import { isFunctionValue, isJsonObject, isJsonValue, isStringValue, type SecretHandle } from "./guards";
import type { MangaDexLibraryItem, MangaDexReadingStatus, MangaDexStat } from "./mangadex";
import { cachedJson, invalidateCachedJson } from "./server-cache";
import { trusted } from "./trusted-cast";

const MANIFOLD_API_ORIGIN = "https://manifold.jfa.dev/api";

// Type aliases (not interfaces) so TanStack Table v9 accepts them as TData.
export type RegistryLink = RegistryListEntry["providers"][number];
export type RegistryListState = NonNullable<RegistryListEntry["state"]>;
export type RegistryEntry = RegistryListEntry;
export type SyncOpItem = SyncOp;
export type ListEventItem = ListEvent;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: secret binding comes from untyped workers env; parsed at I/O boundary
async function resolveSecret(binding: unknown): Promise<string> {
  if (isStringValue(binding)) {
    return binding;
  }
  if (isJsonObject(binding)) {
    // SAFETY: binding is validated as JsonObject and SecretHandle shape is owned; narrow to handle type
    const handle = binding as SecretHandle;
    if (isFunctionValue(handle.get)) {
      const value = await handle.get();
      return isStringValue(value) ? value : "";
    }
    if (isStringValue(handle.value)) {
      return handle.value;
    }
  }
  return "";
}

// Indirect the specifier so bundlers (rolldown) don't try to resolve
// "cloudflare:workers" at build time — workerd provides it at runtime.
const WORKERS_MODULE = "cloudflare:workers";

const workersEnv = async (): Promise<(typeof import("cloudflare:workers"))["env"]> => {
  const mod: unknown = await import(/* @vite-ignore */ WORKERS_MODULE);
  if (!isJsonObject(mod) || !("env" in mod)) {
    throw new Error("cloudflare:workers module unavailable");
  }
  // SAFETY: workerd provides env, validated by isJsonObject and "env" in check; narrow to env holder
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: validated above
  const envValue = (mod as { readonly env: unknown }).env;
  return trusted(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: env is owned runtime contract, validated above
    envValue as (typeof import("cloudflare:workers"))["env"],
  );
};

const call = async <A>(
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<A> => {
  const env = await workersEnv();
  const token = await resolveSecret(env.MANIFOLD_TOKEN);
  if (!token) {
    throw new Error("MANIFOLD_TOKEN binding is not configured for the admin app");
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
  };
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers,
  };
  if (init?.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }
  const response = await (binding
    ? binding.fetch(new Request(target, requestInit))
    : fetch(target, requestInit));
  const text = await response.text();
  let raw: unknown = undefined;
  try {
    raw = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    raw = text;
  }
  if (!response.ok) {
    const message =
      isJsonObject(raw) && "error" in raw
        ? isStringValue(raw.error)
          ? raw.error
          : JSON.stringify(raw.error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (raw !== undefined && !isJsonValue(raw)) {
    throw new Error(`Personal API response is not JSON (${path})`);
  }
  const body = raw === undefined ? null : raw;
  return decodeResponse(schema, body, path);
};

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

const capture = async <A>(
  label: string,
  action: () => Promise<A>,
): Promise<{ ok: true; value: A } | { ok: false; error: string }> => {
  try {
    return { ok: true, value: await action() };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[admin/registry] ${label} failed: ${message}`);
    return { ok: false, error: message };
  }
};

// /v1/registry defaults to LIMIT 500 — page through it so the admin
// always sees the whole registry.
const loadAllEntries = async (): Promise<readonly RegistryEntry[]> => {
  const pageSize = 500;
  const all: RegistryEntry[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await call(
      `/v1/registry?limit=${pageSize}&offset=${offset}`,
      RegistryListResponse,
    );
    all.push(...page.entries);
    if (page.entries.length < pageSize) {
      break;
    }
  }
  return all;
};

export const loadRegistry = createServerFn({ method: "GET" }).handler(
  async (): Promise<LoadRegistryResult> => {
    const registry = await capture("registry", loadAllEntries);
    return registry.ok ? { entries: registry.value } : { entries: [], error: registry.error };
  },
);

export const loadOperations = createServerFn({ method: "GET" }).handler(
  async (): Promise<LoadOperationsResult> => {
    const [ops, events] = await Promise.all([
      capture("ops", () => call("/v1/ops?limit=200", OpsListResponse)),
      capture("events", () => call("/v1/events?limit=100", EventsListResponse)),
    ]);
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
  .handler(async ({ data }) => {
    const { entryId, ...patch } = data;
    return call(
      `/v1/entries/${encodeURIComponent(entryId)}/list-state`,
      ListState,
      {
        method: "POST",
        body: { ...patch, origin: "admin" },
      },
    );
  });

interface BindInput {
  readonly entryId: string;
  readonly provider: string;
  readonly externalId: string;
}

export const bindProvider = createServerFn({ method: "POST" })
  .validator((data: BindInput) => data)
  .handler(async ({ data }) =>
    call(
      `/v1/entries/${encodeURIComponent(data.entryId)}/providers`,
      ContractRegistryEntry,
      {
        method: "POST",
        body: { provider: data.provider, externalId: data.externalId },
      },
    ),
  );

interface UnlinkInput {
  readonly entryId: string;
  readonly provider: string;
}

export const unlinkProvider = createServerFn({ method: "POST" })
  .validator((data: UnlinkInput) => data)
  .handler(async ({ data }) =>
    call(
      `/v1/entries/${encodeURIComponent(data.entryId)}/unlink/${data.provider}`,
      ContractRegistryEntry,
      { method: "POST" },
    ),
  );

export const nukeEntry = createServerFn({ method: "POST" })
  .validator((data: { entryId: string }) => data)
  .handler(async ({ data }) =>
    call(
      `/v1/entries/${encodeURIComponent(data.entryId)}/delete`,
      OkWithListStateResponse,
      {
        method: "POST",
        body: { origin: "admin" },
      },
    ),
  );

export const retryOp = createServerFn({ method: "POST" })
  .validator((data: { opId: string }) => data)
  .handler(async ({ data }) =>
    call(
      `/v1/ops/${encodeURIComponent(data.opId)}/retry`,
      SyncOp,
      { method: "POST" },
    ),
  );

export const loadMangaDexLibrary = createServerFn({ method: "POST" })
  .validator((data: { status?: MangaDexReadingStatus } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<readonly MangaDexLibraryItem[]> => {
    const status = data.status;
    const path =
      status === undefined
        ? "/v1/mangadex/library"
        : `/v1/mangadex/library?status=${encodeURIComponent(status)}`;
    const body = await call(path, MangaDexLibraryResponse);
    return body.library.map((item) => ({
      mangaDexId: item.mangaDexId,
      status: item.status,
      entryId: item.entryId,
      ...(item.title !== undefined && { title: item.title }),
      ...(item.coverUrl !== undefined && { coverUrl: item.coverUrl }),
      ...(item.hasRating !== undefined && { hasRating: item.hasRating }),
      ...(item.rating !== undefined && { rating: item.rating }),
      ...(item.ratingCreatedAt !== undefined && { ratingCreatedAt: item.ratingCreatedAt }),
    }));
  });

/**
 * Reading stats for a page slice of the MangaDex library. Entries whose stats
 * are not (yet) computable are simply absent from the response.
 */
export const loadMangaDexStats = createServerFn({ method: "POST" })
  .validator((data: { ids: readonly string[] }) => data)
  .handler(async ({ data }): Promise<Record<string, MangaDexStat>> => {
    const ids = [...new Set(data.ids)].slice(0, 200);
    if (ids.length === 0) {
      return {};
    }
    const body = await call("/v1/mangadex/stats", MangaDexStatsResponse, {
      method: "POST",
      body: { ids },
    });
    return body.stats;
  });

/** Pass "unset" to clear the reading status (null on the MangaDex API). */
export const setMangaDexStatus = createServerFn({ method: "POST" })
  .validator((data: { mangaDexId: string; status: MangaDexReadingStatus | "unset" }) => data)
  .handler(async ({ data }) => {
    await call(`/v1/mangadex/status/${data.mangaDexId}`, OkResponse, {
      method: "POST",
      body: { status: data.status === "unset" ? null : data.status },
    });
  });

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

/**
 * Compact registry / ops / MangaDex-shelf metrics for the Overview page.
 * Hits dedicated summary endpoints so a cold dashboard never pays for full
 * MangaDex title/cover hydration or paging the entire registry over the wire.
 * Result is cached (KV + in-isolate) with stale-while-revalidate — see server-cache.ts.
 */
export const getLibraryOverview = createServerFn({ method: "GET" }).handler(
  (): Promise<LibraryOverview> =>
    cachedJson("library-overview:v2", async () => {
      const [registry, ops, mangadex] = await Promise.all([
        capture("registry", () =>
          call("/v1/registry/summary", RegistrySummaryResponse).then((body) => body.summary),
        ),
        capture("ops", () =>
          call("/v1/ops/summary?limit=200", OpsSummaryResponse).then((body) => body.summary),
        ),
        capture("mangadex library", () =>
          call("/v1/mangadex/library/summary", MangaDexLibrarySummaryResponse).then(
            (body) => body.summary,
          ),
        ),
      ]);
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
        fetchedAt: new Date().toISOString(),
        registry: registry.ok ? registry.value : null,
        ops: ops.ok ? ops.value : null,
        mangadex: mangadex.ok ? mangadex.value : null,
        errors,
      };
      return { value: overview, cacheable: errors.length === 0 };
    }),
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

export const loadAuthConnections = createServerFn({ method: "GET" }).handler(
  async (): Promise<readonly AuthConnection[]> => {
    try {
      return await call("/v1/auth", AuthConnectionsResponse);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[admin/registry] auth connections failed: ${message}`);
      return [];
    }
  },
);

/**
 * MangaDex password-grant bootstrap. Uses the MANGADEX_* deployment secrets
 * already bound to the sync Worker — never asks the browser for a password.
 * Mints encrypted access/refresh tokens into the personal Durable Object.
 */
export const loginMangaDex = createServerFn({ method: "POST" }).handler(
  async (): Promise<AuthConnection> => {
    const connection = await call("/v1/auth/mangadex/login", AuthConnectionSchema, {
      method: "POST",
    });
    // Library overview caches a failed mangadex snapshot until soft TTL;
    // drop it so Overview reflects the new connection immediately.
    await invalidateCachedJson("library-overview:v1");
    await invalidateCachedJson("library-overview:v2");
    return connection;
  },
);

/**
 * MAL only — authorization-code flow works from Worker egress.
 * AniList code exchange returns 403 on CF IPs; use importAniListToken instead.
 */
export const startMalOAuth = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ readonly authorizationUrl: string }> => {
    const start = await call(
      `/v1/auth/mal/start?return=${encodeURIComponent("/admin/credentials")}`,
      OAuthStart,
    );
    if (!isStringValue(start.authorizationUrl) || start.authorizationUrl.length === 0) {
      throw new Error("OAuth start for mal returned no authorization URL");
    }
    return { authorizationUrl: start.authorizationUrl };
  },
);

/**
 * Stores a browser-minted AniList access token on the personal DO.
 * Token is obtained via AniList implicit OAuth (client 49218) or paste;
 * the Worker never calls AniList's token endpoint.
 */
export const importAniListToken = createServerFn({ method: "POST" })
  .validator((data: { accessToken: string; expiresIn?: number }) => data)
  .handler(async ({ data }): Promise<AuthConnection> => {
    const accessToken = data.accessToken.trim();
    if (!accessToken) {
      throw new Error("AniList access token is empty");
    }
    const connection = await call(
      "/v1/auth/anilist/token",
      AuthConnectionSchema,
      data.expiresIn !== undefined && data.expiresIn > 0
        ? { method: "POST", body: { accessToken, expiresIn: data.expiresIn } }
        : { method: "POST", body: { accessToken } },
    );
    await invalidateCachedJson("library-overview:v1");
    await invalidateCachedJson("library-overview:v2");
    return connection;
  });

/**
 * Public AniList client for browser/device implicit login (MANIFOLD_ADMIN_ANILIST_CLIENT_ID).
 * Confidential 49060 rejects response_type=token. Tracker/Paperback use the same id.
 * Registered redirect: https://manifold.jfa.dev/admin/api/anilist/callback
 * Authorize URL matches AniList implicit docs + tracker OAuthButtonRow: no redirect_uri
 * query param — AniList uses the app's registered redirect.
 */
export const ANILIST_IMPLICIT_CLIENT_ID = "49218";

export const ANILIST_IMPLICIT_CALLBACK_PATH = "/admin/api/anilist/callback";

/** Same shape as tracker OAuthButtonRow (clientId + response_type=token only). */
export const anilistImplicitAuthorizeUrl = (): string =>
  `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(ANILIST_IMPLICIT_CLIENT_ID)}` +
  `&response_type=token`;

export const disconnectAuth = createServerFn({ method: "POST" })
  .validator((data: { provider: AuthProvider }) => data)
  .handler(async ({ data }): Promise<AuthConnection> => {
    const provider = data.provider;
    if (!isAuthProvider(provider)) {
      throw new Error(`Unknown auth provider: ${String(provider)}`);
    }
    await call(
      `/v1/auth/${encodeURIComponent(provider)}`,
      AuthDisconnectedResponse,
      { method: "DELETE" },
    );
    await invalidateCachedJson("library-overview:v1");
    await invalidateCachedJson("library-overview:v2");
    return { provider, connected: false };
  });
