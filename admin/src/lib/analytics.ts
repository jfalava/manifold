import { createServerFn } from "@tanstack/react-start";

import { manifoldUserAgent } from "@manifold/json";
import {
  isFunctionValue,
  isJsonObject,
  isNumberValue,
  isSecretHandleObject,
  isStringValue,
  type JsonValue,
  type SecretHandle,
} from "./guards";
import { cachedJson } from "./server-cache";
import { trusted } from "./trusted-cast";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const REST_URL = "https://api.cloudflare.com/client/v4";
const WINDOW_HOURS = 24;
// Zone-level HTTP analytics on the free plan reject time ranges wider than
// 1d, so the cache window stays a hair under it.
const CACHE_WINDOW_HOURS = 23;
const ZONE_NAME = "jfa.dev";
const PUBLIC_HOSTNAME = "manifold.jfa.dev";

export type LogicalWorker = "ManifoldRouter" | "ManifoldApi" | "ManifoldDocs" | "manifold-admin";

export type WorkerKind = "worker" | "static-site";

const WORKER_SCRIPTS: readonly {
  logical: LogicalWorker;
  kind: WorkerKind;
  scriptName: string;
}[] = [
  {
    logical: "ManifoldRouter",
    kind: "worker",
    scriptName: "manifold-router",
  },
  {
    logical: "ManifoldApi",
    kind: "worker",
    scriptName: "manifold-api",
  },
  {
    logical: "ManifoldDocs",
    kind: "worker",
    scriptName: "manifold-docs",
  },
  { logical: "manifold-admin", kind: "worker", scriptName: "manifold-admin" },
];

export const LOGICAL_WORKERS: readonly LogicalWorker[] = WORKER_SCRIPTS.map(
  (worker) => worker.logical,
);

/** Deployed workers and their kind, for the Overview status table. */
export const WORKER_CATALOG: readonly { logical: LogicalWorker; kind: WorkerKind }[] =
  WORKER_SCRIPTS.map((worker) => ({ logical: worker.logical, kind: worker.kind }));

export interface WorkerTraffic {
  requests: number;
  errors: number;
}

export interface HourlyPoint {
  hour: string;
  requests: number;
  errors: number;
}

export interface AnalyticsSnapshot {
  ok: boolean;
  reason: string | null;
  fetchedAt: string;
  workerTraffic: Partial<Record<LogicalWorker, WorkerTraffic>>;
  totalRequests: number;
  totalErrors: number;
  doRequests: number;
  doStoredBytes: number | null;
  hourly: Record<LogicalWorker, HourlyPoint[]>;
}

interface InvocationsRow {
  dimensions: { scriptName: string; datetimeHour?: string };
  sum: { requests: number; errors: number };
}

function graphqlErrorMessage(value: JsonValue): string[] {
  if (!isJsonObject(value)) {
    return [];
  }
  const message = value.message;
  return isStringValue(message) ? [message] : [];
}

interface DoInvocationsRow {
  sum: { requests: number };
}

interface DoStorageRow {
  max: { storedBytes: number | null };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: secret binding comes from untyped workers env; parsed at I/O boundary via isString/isSecretHandle
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (isStringValue(binding)) {
    return binding;
  }
  if (isSecretHandleObject(binding)) {
    const handle: SecretHandle = binding;
    if (isFunctionValue(handle.get)) {
      const value = await handle.get();
      return isStringValue(value) ? value : null;
    }
    if (isStringValue(handle.value)) {
      return handle.value;
    }
  }
  return null;
}

function sinceIso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

function dayIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function runGraphQL<T>(
  apiToken: string,
  query: string,
  variables: Record<string, string>,
): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
      "user-agent": manifoldUserAgent("admin"),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isJsonObject(payload)) {
    throw new Error("GraphQL response was not an object");
  }
  const errorsValue = payload.errors;
  const messages = Array.isArray(errorsValue)
    ? // SAFETY: errorsValue is JsonValue array from owned GraphQL endpoint; elements are validated by graphqlErrorMessage
      (errorsValue as readonly JsonValue[]).flatMap(graphqlErrorMessage)
    : [];
  if (messages.length > 0) {
    throw new Error(messages.join("; "));
  }
  if (!isJsonObject(payload.data)) {
    throw new Error("GraphQL response missing data");
  }
  return trusted<T>(payload.data);
}

function emptyHourly(): Record<LogicalWorker, HourlyPoint[]> {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: empty arrays are intentionally widened to HourlyPoint[]; no evidence discarded (no elements)
  return {
    ManifoldRouter: [],
    ManifoldApi: [],
    ManifoldDocs: [],
    "manifold-admin": [],
  };
}

// Indirect the specifier so bundlers don't try to resolve "cloudflare:workers"
// at build time — workerd provides it at runtime.
const WORKERS_MODULE = "cloudflare:workers";

async function workersEnv(): Promise<(typeof import("cloudflare:workers"))["env"]> {
  const mod: unknown = await import(/* @vite-ignore */ WORKERS_MODULE);
  if (!isJsonObject(mod) || !("env" in mod)) {
    throw new Error("cloudflare:workers module unavailable");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: workerd provides env, validated by isJsonObject and "env" check
  const envValue = (mod as { readonly env: unknown }).env;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: env shape is owned by workerd runtime; validated via isJsonObject check above
  return trusted(envValue as (typeof import("cloudflare:workers"))["env"]);
}

function emptyAnalyticsSnapshot(reason: string, fetchedAt: string): AnalyticsSnapshot {
  return {
    ok: false,
    reason,
    fetchedAt,
    workerTraffic: {},
    totalRequests: 0,
    totalErrors: 0,
    doRequests: 0,
    doStoredBytes: null,
    hourly: emptyHourly(),
  };
}

async function fetchSnapshot(): Promise<AnalyticsSnapshot> {
  const fetchedAt = new Date().toISOString();

  try {
    const env = await workersEnv();
    const accountTag = env.CF_ACCOUNT_ID;
    const apiToken = await resolveSecret(env.MANIFOLD_ADMIN_PANEL_ANALYTICS_API);

    if (
      !isStringValue(apiToken) ||
      apiToken === "" ||
      !isStringValue(accountTag) ||
      accountTag === ""
    ) {
      return emptyAnalyticsSnapshot(
        "MANIFOLD_ADMIN_PANEL_ANALYTICS_API / CF_ACCOUNT_ID bindings are not configured",
        fetchedAt,
      );
    }
    const [invocationsData, doData, storageData] = await Promise.all([
      runGraphQL<{
        viewer: { accounts: { workersInvocationsAdaptive: InvocationsRow[] }[] };
      }>(
        apiToken,

        `query($accountTag: string!, $since: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              workersInvocationsAdaptive(
                limit: 100
                filter: { datetime_geq: $since }
              ) {
                sum { requests errors }
                dimensions { scriptName datetimeHour }
              }
            }
          }
        }`,
        { accountTag, since: sinceIso(WINDOW_HOURS) },
      ),
      runGraphQL<{
        viewer: {
          accounts: {
            durableObjectsInvocationsAdaptiveGroups: DoInvocationsRow[];
          }[];
        };
      }>(
        apiToken,

        `query($accountTag: string!, $since: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              durableObjectsInvocationsAdaptiveGroups(
                limit: 10
                filter: { datetime_geq: $since }
              ) {
                sum { requests }
              }
            }
          }
        }`,
        { accountTag, since: sinceIso(WINDOW_HOURS) },
      ),
      runGraphQL<{
        viewer: { accounts: { durableObjectsStorageGroups: DoStorageRow[] }[] };
      }>(
        apiToken,

        `query($accountTag: string!, $since: Date!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              durableObjectsStorageGroups(
                limit: 10
                filter: { date_geq: $since }
              ) {
                max { storedBytes }
              }
            }
          }
        }`,
        { accountTag, since: dayIso(7) },
      ),
    ]);

    const rows = invocationsData.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];

    const workerTraffic: Partial<Record<LogicalWorker, WorkerTraffic>> = {};
    let totalRequests = 0;
    let totalErrors = 0;
    const hourly = emptyHourly();

    for (const { logical, scriptName } of WORKER_SCRIPTS) {
      const matching = rows.filter((row) => row.dimensions.scriptName === scriptName);
      const requests = matching.reduce((acc, row) => acc + row.sum.requests, 0);
      const errors = matching.reduce((acc, row) => acc + row.sum.errors, 0);
      if (matching.length > 0) {
        workerTraffic[logical] = { requests, errors };
      }
      totalRequests += requests;
      totalErrors += errors;
      hourly[logical] = matching
        .map((row) => ({
          hour: row.dimensions.datetimeHour ?? "",
          requests: row.sum.requests,
          errors: row.sum.errors,
        }))
        .filter((point) => point.hour !== "")
        .toSorted((a, b) => a.hour.localeCompare(b.hour));
    }

    const doRequests =
      doData.viewer.accounts[0]?.durableObjectsInvocationsAdaptiveGroups.reduce(
        (acc, row) => acc + row.sum.requests,
        0,
      ) ?? 0;

    const storedValues = storageData.viewer.accounts[0]?.durableObjectsStorageGroups
      .map((row) => row.max.storedBytes)
      .filter((value): value is number => isNumberValue(value));
    const doStoredBytes =
      storedValues && storedValues.length > 0 ? Math.max(...storedValues) : null;

    return {
      ok: true,
      reason: null,
      fetchedAt,
      workerTraffic,
      totalRequests,
      totalErrors,
      doRequests,
      doStoredBytes,
      hourly,
    };
  } catch (error) {
    return emptyAnalyticsSnapshot(
      error instanceof Error ? error.message : "analytics query failed",
      fetchedAt,
    );
  }
}

export const getAnalyticsSnapshot = createServerFn({ method: "GET" }).handler(
  (): Promise<AnalyticsSnapshot> =>
    cachedJson("analytics-snapshot:v1", async () => {
      const snapshot = await fetchSnapshot();
      return { value: snapshot, cacheable: snapshot.ok };
    }),
);

// ------------------------------------------------------------------
// Edge cache analytics (zone-level HTTP requests by cacheStatus)
// ------------------------------------------------------------------

export interface CacheStatusSlice {
  status: string;
  requests: number;
  bytes: number;
}

export interface SurfaceCacheStat {
  surface: string;
  pathPrefix: string;
  requests: number;
  hits: number;
  misses: number;
  uncacheable: number;
  bytes: number;
}

export interface CacheSnapshot {
  ok: boolean;
  reason: string | null;
  fetchedAt: string;
  windowHours: number;
  statuses: CacheStatusSlice[];
  surfaces: SurfaceCacheStat[];
  totalRequests: number;
  totalBytes: number;
  /** Requests the edge could cache (everything but none/dynamic/bypass). */
  cacheableRequests: number;
  cacheHits: number;
  cachedBytes: number;
}

/** cacheStatus values counted as served-from-cache. */
const HIT_STATUSES: ReadonlySet<string> = new Set(["hit", "stale", "revalidated", "updating"]);
/** cacheStatus values that never enter the cache (workers/dynamic/bypassed). */
const UNCACHEABLE_STATUSES: ReadonlySet<string> = new Set(["none", "dynamic", "bypass", "unknown"]);

/** Router mounts, matched in order; "/" catches the docs fallthrough. */
const SURFACE_PREFIXES: readonly { surface: string; pathPrefix: string }[] = [
  { surface: "Sync API", pathPrefix: "/api" },
  { surface: "Admin panel", pathPrefix: "/admin" },
  { surface: "Paperback catalog", pathPrefix: "/paperback" },
  { surface: "MangaDex cover proxy", pathPrefix: "/mangadex-cover" },
  { surface: "Docs", pathPrefix: "/" },
];

interface CacheStatusRow {
  count: number;
  sum: { edgeResponseBytes: number };
  dimensions: { cacheStatus: string | null; clientRequestPath?: string };
}

let zoneTagCache: string | null = null;

async function resolveZoneTag(apiToken: string): Promise<string> {
  if (zoneTagCache !== null) {
    return zoneTagCache;
  }
  const response = await fetch(`${REST_URL}/zones?name=${encodeURIComponent(ZONE_NAME)}`, {
    headers: {
      authorization: `Bearer ${apiToken}`,
      "user-agent": manifoldUserAgent("admin"),
    },
  });
  if (!response.ok) {
    throw new Error(`zone lookup HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isJsonObject(payload) || !Array.isArray(payload.result)) {
    throw new Error("zone lookup returned an unexpected shape");
  }
  // SAFETY: payload.result is a JsonValue array from the owned Cloudflare REST endpoint; the element is validated below
  const [zone] = payload.result as readonly JsonValue[];
  if (!isJsonObject(zone) || !isStringValue(zone.id)) {
    throw new Error(`zone ${ZONE_NAME} not visible to the analytics token`);
  }
  zoneTagCache = zone.id;
  return zone.id;
}

const matchSurface = (path: string): { surface: string; pathPrefix: string } =>
  SURFACE_PREFIXES.find(
    ({ pathPrefix }) =>
      pathPrefix === "/" || path === pathPrefix || path.startsWith(`${pathPrefix}/`),
  ) ?? SURFACE_PREFIXES[SURFACE_PREFIXES.length - 1];

function emptyCacheSnapshot(reason: string, fetchedAt: string): CacheSnapshot {
  return {
    ok: false,
    reason,
    fetchedAt,
    windowHours: CACHE_WINDOW_HOURS,
    statuses: [],
    surfaces: [],
    totalRequests: 0,
    totalBytes: 0,
    cacheableRequests: 0,
    cacheHits: 0,
    cachedBytes: 0,
  };
}

async function fetchCacheSnapshot(): Promise<CacheSnapshot> {
  const fetchedAt = new Date().toISOString();

  try {
    const env = await workersEnv();
    const apiToken = await resolveSecret(env.MANIFOLD_ADMIN_PANEL_ANALYTICS_API);
    if (!isStringValue(apiToken) || apiToken === "") {
      return emptyCacheSnapshot("MANIFOLD_ADMIN_PANEL_ANALYTICS_API binding is not configured", fetchedAt);
    }

    const zoneTag = await resolveZoneTag(apiToken);
    const data = await runGraphQL<{
      viewer: {
        zones: {
          totals: CacheStatusRow[];
          paths: CacheStatusRow[];
        }[];
      };
    }>(
      apiToken,

      `query($zoneTag: string!, $since: Time!, $host: string!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            totals: httpRequestsAdaptiveGroups(
              limit: 50
              filter: { datetime_geq: $since, clientRequestHTTPHost: $host }
            ) {
              count
              sum { edgeResponseBytes }
              dimensions { cacheStatus }
            }
            paths: httpRequestsAdaptiveGroups(
              limit: 2000
              filter: { datetime_geq: $since, clientRequestHTTPHost: $host }
              orderBy: [count_DESC]
            ) {
              count
              sum { edgeResponseBytes }
              dimensions { cacheStatus clientRequestPath }
            }
          }
        }
      }`,
      {
        zoneTag,
        since: sinceIso(CACHE_WINDOW_HOURS),
        host: PUBLIC_HOSTNAME,
      },
    );

    const zone = data.viewer.zones[0];
    const totals = zone?.totals ?? [];
    const pathRows = zone?.paths ?? [];

    const statuses = totals
      .map((row) => ({
        status: row.dimensions.cacheStatus ?? "unknown",
        requests: row.count,
        bytes: row.sum.edgeResponseBytes,
      }))
      .toSorted((a, b) => b.requests - a.requests);

    let totalRequests = 0;
    let totalBytes = 0;
    let cacheableRequests = 0;
    let cacheHits = 0;
    let cachedBytes = 0;
    for (const slice of statuses) {
      totalRequests += slice.requests;
      totalBytes += slice.bytes;
      if (!UNCACHEABLE_STATUSES.has(slice.status)) {
        cacheableRequests += slice.requests;
      }
      if (HIT_STATUSES.has(slice.status)) {
        cacheHits += slice.requests;
        cachedBytes += slice.bytes;
      }
    }

    const bySurface = new Map<string, SurfaceCacheStat>();
    for (const { surface, pathPrefix } of SURFACE_PREFIXES) {
      bySurface.set(surface, {
        surface,
        pathPrefix,
        requests: 0,
        hits: 0,
        misses: 0,
        uncacheable: 0,
        bytes: 0,
      });
    }
    for (const row of pathRows) {
      const status = row.dimensions.cacheStatus ?? "unknown";
      const stat = bySurface.get(matchSurface(row.dimensions.clientRequestPath ?? "/").surface)!;
      stat.requests += row.count;
      stat.bytes += row.sum.edgeResponseBytes;
      if (HIT_STATUSES.has(status)) {
        stat.hits += row.count;
      } else if (UNCACHEABLE_STATUSES.has(status)) {
        stat.uncacheable += row.count;
      } else {
        stat.misses += row.count;
      }
    }

    return {
      ok: true,
      reason: null,
      fetchedAt,
      windowHours: CACHE_WINDOW_HOURS,
      statuses,
      surfaces: [...bySurface.values()].filter((stat) => stat.requests > 0),
      totalRequests,
      totalBytes,
      cacheableRequests,
      cacheHits,
      cachedBytes,
    };
  } catch (error) {
    return emptyCacheSnapshot(
      error instanceof Error ? error.message : "cache analytics query failed",
      fetchedAt,
    );
  }
}

export const getCacheSnapshot = createServerFn({ method: "GET" }).handler(
  (): Promise<CacheSnapshot> =>
    cachedJson("cache-snapshot:v1", async () => {
      const snapshot = await fetchCacheSnapshot();
      return { value: snapshot, cacheable: snapshot.ok };
    }),
);
