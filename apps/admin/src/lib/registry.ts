import { createServerFn } from "@tanstack/react-start";

import { isFunctionValue, isJsonObject, isStringValue, type SecretHandle } from "./guards";
import type { MangaDexLibraryItem, MangaDexReadingStatus, MangaDexStat } from "./mangadex";
import { cachedJson, invalidateCachedJson } from "./server-cache";
import { trusted } from "./trusted-cast";

const MANIFOLD_API_ORIGIN = "https://manifold.jfa.dev/api";

export interface RegistryLink {
  readonly provider: string;
  readonly externalId: string;
  readonly title?: string;
  readonly updatedAt: number;
}

export interface RegistryListState {
  readonly entryId: string;
  readonly status?: string;
  readonly score?: number;
  readonly notes?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly volumeProgress?: number;
  readonly mediaListEntryId?: number;
  readonly updatedAt: number;
}

// Type aliases (not interfaces) so TanStack Table v9's `TData extends Record<string, any>` constraint accepts them
export type ChapterSource = "auto" | "mangadex" | "comix";

export type RegistryEntry = {
  readonly id: string;
  readonly provider: string;
  readonly providerId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providers: readonly RegistryLink[];
  readonly state?: RegistryListState;
  readonly tombstoned?: boolean;
  /** Chapter list pin. Omitted or auto = device heuristic. */
  readonly chapterSource?: ChapterSource;
};

export type SyncOpItem = {
  readonly id: number;
  readonly opId: string;
  readonly target: string;
  readonly kind: string;
  readonly origin: string;
  readonly payload: Record<string, string | number | boolean | null>;
  readonly state: string;
  readonly attempts: number;
  readonly lastError?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ListEventItem = {
  readonly id: number;
  readonly entryId: string;
  readonly kind: string;
  readonly origin: string;
  readonly detail?: Record<string, string | number | boolean | null>;
  readonly createdAt: number;
};

export type UpdateProbeFailureItem = {
  readonly id: number;
  readonly entryId?: string;
  readonly title: string;
  readonly source: string;
  readonly reason: string;
  readonly detail?: string;
  readonly createdAt: number;
};

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
  let body: unknown = undefined;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message =
      isJsonObject(body) && "error" in body
        ? isStringValue(body.error)
          ? body.error
          : JSON.stringify(body.error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return trusted<A>(body);
};

export interface LoadRegistryResult {
  readonly entries: readonly RegistryEntry[];
  readonly error?: string;
}

export interface LoadOperationsResult {
  readonly ops: readonly SyncOpItem[];
  readonly events: readonly ListEventItem[];
  readonly updateFailures: readonly UpdateProbeFailureItem[];
  readonly errors: {
    readonly ops?: string;
    readonly events?: string;
    readonly updateFailures?: string;
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
    const page = await call<{ entries: readonly RegistryEntry[] }>(
      `/v1/registry?limit=${pageSize}&offset=${offset}`,
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
    const [ops, events, updateFailures] = await Promise.all([
      capture("ops", () => call<{ ops: readonly SyncOpItem[] }>("/v1/ops?limit=200")),
      capture("events", () => call<{ events: readonly ListEventItem[] }>("/v1/events?limit=100")),
      capture("update-failures", () =>
        call<{ failures: readonly UpdateProbeFailureItem[] }>("/v1/update-failures?limit=200"),
      ),
    ]);
    const errors: {
      ops?: string;
      events?: string;
      updateFailures?: string;
    } = {}; // oxlint-disable-line anti-slop/no-known-value-widening -- SAFETY: errors map starts empty and is populated conditionally; anonymous type is intentionally widened from empty object
    if (!ops.ok) {
      errors.ops = ops.error;
    }
    if (!events.ok) {
      errors.events = events.error;
    }
    if (!updateFailures.ok) {
      errors.updateFailures = updateFailures.error;
    }
    return {
      ops: ops.ok ? ops.value.ops : [],
      events: events.ok ? events.value.events : [],
      updateFailures: updateFailures.ok ? updateFailures.value.failures : [],
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
    return call<{ ok: boolean }>(`/v1/entries/${encodeURIComponent(entryId)}/list-state`, {
      method: "POST",
      body: { ...patch, origin: "admin" },
    });
  });

interface ChapterSourceInput {
  readonly entryId: string;
  readonly chapterSource: ChapterSource;
}

export const saveChapterSource = createServerFn({ method: "POST" })
  .validator((data: ChapterSourceInput) => data)
  .handler(async ({ data }) =>
    call<{ ok: boolean }>(`/v1/entries/${encodeURIComponent(data.entryId)}/chapter-source`, {
      method: "POST",
      body: { chapterSource: data.chapterSource, origin: "admin" },
    }),
  );

interface BindInput {
  readonly entryId: string;
  readonly provider: string;
  readonly externalId: string;
}

export const bindProvider = createServerFn({ method: "POST" })
  .validator((data: BindInput) => data)
  .handler(async ({ data }) =>
    call<{ ok: boolean }>(`/v1/entries/${encodeURIComponent(data.entryId)}/providers`, {
      method: "POST",
      body: { provider: data.provider, externalId: data.externalId },
    }),
  );

interface UnlinkInput {
  readonly entryId: string;
  readonly provider: string;
}

export const unlinkProvider = createServerFn({ method: "POST" })
  .validator((data: UnlinkInput) => data)
  .handler(async ({ data }) =>
    call<{ ok: boolean }>(
      `/v1/entries/${encodeURIComponent(data.entryId)}/unlink/${data.provider}`,
      { method: "POST" },
    ),
  );

export const nukeEntry = createServerFn({ method: "POST" })
  .validator((data: { entryId: string }) => data)
  .handler(async ({ data }) =>
    call<{ ok: boolean }>(`/v1/entries/${encodeURIComponent(data.entryId)}/delete`, {
      method: "POST",
      body: { origin: "admin" },
    }),
  );

export const retryOp = createServerFn({ method: "POST" })
  .validator((data: { opId: string }) => data)
  .handler(async ({ data }) =>
    call<{ ok: boolean }>(`/v1/ops/${encodeURIComponent(data.opId)}/retry`, {
      method: "POST",
    }),
  );

export const loadMangaDexLibrary = createServerFn({ method: "POST" })
  .validator((data: { status?: MangaDexReadingStatus } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<readonly MangaDexLibraryItem[]> => {
    const status = data.status;
    const path =
      status === undefined
        ? "/v1/mangadex/library"
        : `/v1/mangadex/library?status=${encodeURIComponent(status)}`;
    const body = await call<{ library: readonly MangaDexLibraryItem[] }>(path);
    return body.library ?? [];
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
    const body = await call<{ stats: Record<string, MangaDexStat> }>("/v1/mangadex/stats", {
      method: "POST",
      body: { ids },
    });
    return body.stats ?? {};
  });

/** Pass "unset" to clear the reading status (null on the MangaDex API). */
export const setMangaDexStatus = createServerFn({ method: "POST" })
  .validator((data: { mangaDexId: string; status: MangaDexReadingStatus | "unset" }) => data)
  .handler(async ({ data }) => {
    await call<void>(`/v1/mangadex/status/${data.mangaDexId}`, {
      method: "POST",
      body: { status: data.status === "unset" ? null : data.status },
    });
  });

// ------------------------------------------------------------------
// Dashboard overview
// ------------------------------------------------------------------

/** Providers a canonical entry can be bound to; "full coverage" = all three trackers. */
export const TRACKER_PROVIDERS = ["anilist", "mal", "mangadex"] as const;

export interface RegistrySummary {
  readonly total: number;
  readonly active: number;
  readonly tombstoned: number;
  /** Active entries by list status; entries without list state count as "unset". */
  readonly statuses: Record<string, number>;
  /** Active entries linked to each provider. */
  readonly providerCounts: Record<string, number>;
  /** Active entries linked to every tracker provider (anilist + mal + mangadex). */
  readonly fullyLinked: number;
  /** Active entries with no provider links at all. */
  readonly unlinked: number;
}

export interface OpsSummary {
  readonly total: number;
  readonly states: Record<string, number>;
  readonly oldestPendingAt: number | null;
  readonly lastFailedError: string | null;
}

export interface MangaDexSummary {
  readonly total: number;
  readonly statuses: Record<string, number>;
  readonly rated: number;
  readonly meanRating: number | null;
  /** Shelf items already resolved to a canonical registry entry. */
  readonly linkedToRegistry: number;
}

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
          call<{ summary: RegistrySummary }>("/v1/registry/summary").then((body) => body.summary),
        ),
        capture("ops", () =>
          call<{ summary: OpsSummary }>("/v1/ops/summary?limit=200").then((body) => body.summary),
        ),
        capture("mangadex library", () =>
          call<{ summary: MangaDexSummary }>("/v1/mangadex/library/summary").then(
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

export type AuthProvider = "anilist" | "mal" | "mangadex";

export type AuthConnection = {
  readonly provider: AuthProvider;
  readonly connected: boolean;
  readonly expiresAt?: number;
  readonly updatedAt?: number;
};

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
    const body = await call<readonly AuthConnection[] | { readonly error: string }>("/v1/auth");
    if (!Array.isArray(body)) {
      return [];
    }
    // Owned /v1/auth contract — elements are AuthConnection rows.
    return trusted<readonly AuthConnection[]>(body);
  },
);

/**
 * MangaDex password-grant bootstrap. Uses the MANGADEX_* deployment secrets
 * already bound to the sync Worker — never asks the browser for a password.
 * Mints encrypted access/refresh tokens into the personal Durable Object.
 */
export const loginMangaDex = createServerFn({ method: "POST" }).handler(
  async (): Promise<AuthConnection> => {
    const connection = await call<AuthConnection>("/v1/auth/mangadex/login", {
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
    const start = await call<{
      readonly provider: "mal";
      readonly authorizationUrl: string;
    }>(`/v1/auth/mal/start?return=${encodeURIComponent("/admin/credentials")}`);
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
    const connection = await call<AuthConnection>(
      "/v1/auth/anilist/token",
      data.expiresIn !== undefined && data.expiresIn > 0
        ? { method: "POST", body: { accessToken, expiresIn: data.expiresIn } }
        : { method: "POST", body: { accessToken } },
    );
    await invalidateCachedJson("library-overview:v1");
    await invalidateCachedJson("library-overview:v2");
    return connection;
  });

/**
 * Public AniList client for browser/device implicit login (ADMIN_ANILIST_CLIENT_ID).
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
    await call<{ provider: AuthProvider; connected: boolean }>(
      `/v1/auth/${encodeURIComponent(provider)}`,
      { method: "DELETE" },
    );
    await invalidateCachedJson("library-overview:v1");
    await invalidateCachedJson("library-overview:v2");
    return { provider, connected: false };
  });
