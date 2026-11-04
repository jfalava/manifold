import {
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import { toJsonText } from "@manifold/json/text";
import { createServerFn } from "@tanstack/react-start";
import { DateTime, Effect } from "effect";

import {
  AdminError,
  platformFetch,
  resolveSecret,
  runHost,
  tryPromise,
  workersRuntime,
} from "./effect-host";
import { cachedJsonProgram, type CacheDecoder, type ComputedSnapshot } from "./server-cache";

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

  return isString(message) ? [message] : [];
}

interface DoInvocationsRow {
  sum: { requests: number };
}

interface DoStorageRow {
  max: { storedBytes: number | null };
}

interface CacheRows {
  totals: CacheStatusRow[];
  paths: CacheStatusRow[];
}

const accountRows = (data: JsonObject, key: string): readonly JsonObject[] | undefined => {
  const viewer = isJsonObject(data.viewer) ? data.viewer : undefined;
  const accounts = viewer?.accounts;

  if (!isJsonArray(accounts)) {
    return undefined;
  }

  const account = accounts[0];

  if (account === undefined) {
    return [];
  }

  if (!isJsonObject(account) || !isJsonArray(account[key]) || !account[key].every(isJsonObject)) {
    return undefined;
  }

  return account[key];
};

const decodeInvocationsRows = (data: JsonObject): InvocationsRow[] | undefined => {
  const rows = accountRows(data, "workersInvocationsAdaptive");

  if (rows === undefined) {
    return undefined;
  }

  const decoded: InvocationsRow[] = [];

  for (const row of rows) {
    const dimensions = row.dimensions;
    const sum = row.sum;

    if (!isJsonObject(dimensions) || !isJsonObject(sum) || !isString(dimensions.scriptName)) {
      return undefined;
    }

    const datetimeHour = dimensions.datetimeHour;

    if (datetimeHour !== undefined && datetimeHour !== null && !isString(datetimeHour)) {
      return undefined;
    }

    if (!isFiniteNumber(sum.requests) || !isFiniteNumber(sum.errors)) {
      return undefined;
    }

    decoded.push({
      dimensions: {
        scriptName: dimensions.scriptName,
        ...(isString(datetimeHour) && { datetimeHour }),
      },
      sum: { requests: sum.requests, errors: sum.errors },
    });
  }

  return decoded;
};

const decodeDoInvocationsRows = (data: JsonObject): DoInvocationsRow[] | undefined => {
  const rows = accountRows(data, "durableObjectsInvocationsAdaptiveGroups");

  if (rows === undefined) {
    return undefined;
  }

  const decoded: DoInvocationsRow[] = [];

  for (const row of rows) {
    const sum = row.sum;

    if (!isJsonObject(sum) || !isFiniteNumber(sum.requests)) {
      return undefined;
    }

    decoded.push({ sum: { requests: sum.requests } });
  }

  return decoded;
};

const decodeDoStorageRows = (data: JsonObject): DoStorageRow[] | undefined => {
  const rows = accountRows(data, "durableObjectsStorageGroups");

  if (rows === undefined) {
    return undefined;
  }

  const decoded: DoStorageRow[] = [];

  for (const row of rows) {
    const max = row.max;

    if (!isJsonObject(max) || (max.storedBytes !== null && !isFiniteNumber(max.storedBytes))) {
      return undefined;
    }

    decoded.push({ max: { storedBytes: max.storedBytes === null ? null : max.storedBytes } });
  }

  return decoded;
};

const decodeCacheStatusRows = (value: JsonValue | undefined): CacheStatusRow[] | undefined => {
  if (!isJsonArray(value) || !value.every(isJsonObject)) {
    return undefined;
  }

  const decoded: CacheStatusRow[] = [];

  for (const row of value) {
    const dimensions = row.dimensions;
    const sum = row.sum;

    if (!isJsonObject(dimensions) || !isJsonObject(sum) || !isFiniteNumber(row.count)) {
      return undefined;
    }

    const cacheStatus = dimensions.cacheStatus;
    const path = dimensions.clientRequestPath;

    if (
      (cacheStatus !== undefined && cacheStatus !== null && !isString(cacheStatus)) ||
      (path !== undefined && path !== null && !isString(path)) ||
      !isFiniteNumber(sum.edgeResponseBytes)
    ) {
      return undefined;
    }

    decoded.push({
      count: row.count,
      sum: { edgeResponseBytes: sum.edgeResponseBytes },
      dimensions: {
        cacheStatus: isString(cacheStatus) ? cacheStatus : null,
        ...(isString(path) && { clientRequestPath: path }),
      },
    });
  }

  return decoded;
};

const decodeCacheRows = (data: JsonObject): CacheRows | undefined => {
  const viewer = isJsonObject(data.viewer) ? data.viewer : undefined;
  const zones = viewer?.zones;

  if (!isJsonArray(zones)) {
    return undefined;
  }

  const zone = zones[0];

  if (zone === undefined) {
    return { totals: [], paths: [] };
  }

  if (!isJsonObject(zone)) {
    return undefined;
  }

  const totals = decodeCacheStatusRows(zone.totals);
  const paths = decodeCacheStatusRows(zone.paths);

  return totals === undefined || paths === undefined ? undefined : { totals, paths };
};

const decodeAnalyticsSnapshot: CacheDecoder<AnalyticsSnapshot> = (value) => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const reason = value.reason;

  if (
    !isString(value.fetchedAt) ||
    !isBoolean(value.ok) ||
    (reason !== null && !isString(reason)) ||
    !isFiniteNumber(value.totalRequests) ||
    !isFiniteNumber(value.totalErrors) ||
    !isFiniteNumber(value.doRequests) ||
    (value.doStoredBytes !== null && !isFiniteNumber(value.doStoredBytes))
  ) {
    return undefined;
  }

  const workerTrafficValue = value.workerTraffic;

  if (!isJsonObject(workerTrafficValue)) {
    return undefined;
  }

  const workerTraffic: Partial<Record<LogicalWorker, WorkerTraffic>> = {};

  for (const [logical, traffic] of Object.entries(workerTrafficValue)) {
    const worker = LOGICAL_WORKERS.find((candidate) => candidate === logical);

    if (worker === undefined || !isJsonObject(traffic)) {
      return undefined;
    }

    if (!isFiniteNumber(traffic.requests) || !isFiniteNumber(traffic.errors)) {
      return undefined;
    }

    workerTraffic[worker] = {
      requests: traffic.requests,
      errors: traffic.errors,
    };
  }

  const hourlyValue = value.hourly;

  if (!isJsonObject(hourlyValue)) {
    return undefined;
  }

  const hourly = emptyHourly();

  for (const logical of LOGICAL_WORKERS) {
    const points = hourlyValue[logical];

    if (!isJsonArray(points)) {
      return undefined;
    }

    const decoded: HourlyPoint[] = [];

    for (const point of points) {
      if (
        !isJsonObject(point) ||
        !isString(point.hour) ||
        !isFiniteNumber(point.requests) ||
        !isFiniteNumber(point.errors)
      ) {
        return undefined;
      }

      decoded.push({ hour: point.hour, requests: point.requests, errors: point.errors });
    }

    hourly[logical] = decoded;
  }

  return {
    ok: value.ok,
    reason,
    fetchedAt: value.fetchedAt,
    workerTraffic,
    totalRequests: value.totalRequests,
    totalErrors: value.totalErrors,
    doRequests: value.doRequests,
    doStoredBytes: value.doStoredBytes,
    hourly,
  };
};

function sinceIso(now: DateTime.Utc, hoursAgo: number): string {
  return DateTime.formatIso(DateTime.subtract(now, { hours: hoursAgo }));
}

function dayIso(now: DateTime.Utc, daysAgo: number): string {
  return DateTime.formatIsoDate(DateTime.subtract(now, { days: daysAgo }));
}

const runGraphQL = Effect.fnUntraced(function* <T>(
  apiToken: string,
  query: string,
  variables: Record<string, string>,
  decode: (data: JsonObject) => T | undefined,
): Effect.fn.Return<T, AdminError> {
  const response = yield* tryPromise(() =>
    platformFetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
        "user-agent": manifoldUserAgent("admin"),
      },
      body: toJsonText({ query, variables }),
    }),
  );

  if (!response.ok) {
    return yield* new AdminError({ message: `GraphQL HTTP ${response.status}` });
  }

  const payload = yield* tryPromise<unknown>(() => response.json());

  if (!isJsonObject(payload) || Array.isArray(payload)) {
    return yield* new AdminError({ message: "GraphQL response was not an object" });
  }

  const errorsValue = payload.errors;

  // Cloudflare returns `errors: null` for successful GraphQL responses.
  if (errorsValue !== undefined && errorsValue !== null && !isJsonArray(errorsValue)) {
    return yield* new AdminError({ message: "GraphQL response errors were not an array" });
  }

  const messages = isJsonArray(errorsValue) ? errorsValue.flatMap(graphqlErrorMessage) : [];

  if (messages.length > 0) {
    return yield* new AdminError({ message: messages.join("; ") });
  }

  if (!isJsonObject(payload.data) || Array.isArray(payload.data)) {
    return yield* new AdminError({ message: "GraphQL response missing data" });
  }

  const decoded = decode(payload.data);

  if (decoded === undefined) {
    return yield* new AdminError({ message: "GraphQL response data had an unexpected shape" });
  }

  return decoded;
});

function emptyHourly(): Record<LogicalWorker, HourlyPoint[]> {
  return {
    ManifoldRouter: new Array<HourlyPoint>(),
    ManifoldApi: new Array<HourlyPoint>(),
    ManifoldDocs: new Array<HourlyPoint>(),
    "manifold-admin": new Array<HourlyPoint>(),
  };
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

const fetchSnapshot = Effect.fnUntraced(function* (): Effect.fn.Return<AnalyticsSnapshot> {
  const now = DateTime.nowUnsafe();
  const fetchedAt = DateTime.formatIso(now);

  return yield* Effect.gen(function* () {
    const { env } = yield* workersRuntime();
    const accountTag = env.CF_ACCOUNT_ID;
    const apiToken = yield* resolveSecret(env.MANIFOLD_ADMIN_PANEL_ANALYTICS_API);

    if (!isString(apiToken) || apiToken === "" || !isString(accountTag) || accountTag === "") {
      return emptyAnalyticsSnapshot(
        "MANIFOLD_ADMIN_PANEL_ANALYTICS_API / CF_ACCOUNT_ID bindings are not configured",
        fetchedAt,
      );
    }

    const [invocationsData, doData, storageData] = yield* Effect.all(
      [
        runGraphQL(
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
          { accountTag, since: sinceIso(now, WINDOW_HOURS) },
          decodeInvocationsRows,
        ),
        runGraphQL(
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
          { accountTag, since: sinceIso(now, WINDOW_HOURS) },
          decodeDoInvocationsRows,
        ),
        runGraphQL(
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
          { accountTag, since: dayIso(now, 7) },
          decodeDoStorageRows,
        ),
      ],
      { concurrency: "unbounded" },
    );

    const rows = invocationsData;

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

    const doRequests = doData.reduce((acc, row) => acc + row.sum.requests, 0);

    const storedValues = storageData
      .map((row) => row.max.storedBytes)
      .filter((value): value is number => isFiniteNumber(value));

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
  }).pipe(
    Effect.catch((error) => Effect.succeed(emptyAnalyticsSnapshot(error.message, fetchedAt))),
  );
});

export const getAnalyticsSnapshot = createServerFn({ method: "GET" }).handler(() =>
  runHost(
    cachedJsonProgram("analytics-snapshot:v1", decodeAnalyticsSnapshot, () =>
      fetchSnapshot().pipe(
        Effect.map((snapshot): ComputedSnapshot<AnalyticsSnapshot> => ({
          value: snapshot,
          cacheable: snapshot.ok,
        })),
      ),
    ),
  ),
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

const DOCS_SURFACE = { surface: "Docs", pathPrefix: "/" };

/** Router mounts, matched in order; "/" catches the docs fallthrough. */
const SURFACE_PREFIXES: readonly { surface: string; pathPrefix: string }[] = [
  { surface: "Sync API", pathPrefix: "/api" },
  { surface: "Admin panel", pathPrefix: "/admin" },
  { surface: "Paperback catalog", pathPrefix: "/paperback" },
  { surface: "MangaDex cover proxy", pathPrefix: "/mangadex-cover" },
  DOCS_SURFACE,
];

interface CacheStatusRow {
  count: number;
  sum: { edgeResponseBytes: number };
  dimensions: { cacheStatus: string | null; clientRequestPath?: string };
}

const decodeCacheStatusSlices = (value: JsonValue | undefined): CacheStatusSlice[] | undefined => {
  if (!isJsonArray(value)) {
    return undefined;
  }

  const statuses: CacheStatusSlice[] = [];

  for (const status of value) {
    if (
      !isJsonObject(status) ||
      !isString(status.status) ||
      !isFiniteNumber(status.requests) ||
      !isFiniteNumber(status.bytes)
    ) {
      return undefined;
    }

    statuses.push({
      status: status.status,
      requests: status.requests,
      bytes: status.bytes,
    });
  }

  return statuses;
};

const decodeSurfaceCacheStats = (value: JsonValue | undefined): SurfaceCacheStat[] | undefined => {
  if (!isJsonArray(value)) {
    return undefined;
  }

  const surfaces: SurfaceCacheStat[] = [];

  for (const surface of value) {
    if (
      !isJsonObject(surface) ||
      !isString(surface.surface) ||
      !isString(surface.pathPrefix) ||
      !isFiniteNumber(surface.requests) ||
      !isFiniteNumber(surface.hits) ||
      !isFiniteNumber(surface.misses) ||
      !isFiniteNumber(surface.uncacheable) ||
      !isFiniteNumber(surface.bytes)
    ) {
      return undefined;
    }

    surfaces.push({
      surface: surface.surface,
      pathPrefix: surface.pathPrefix,
      requests: surface.requests,
      hits: surface.hits,
      misses: surface.misses,
      uncacheable: surface.uncacheable,
      bytes: surface.bytes,
    });
  }

  return surfaces;
};

const decodeCacheSnapshot: CacheDecoder<CacheSnapshot> = (value) => {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const reason = value.reason;

  if (
    !isBoolean(value.ok) ||
    !isString(value.fetchedAt) ||
    (reason !== null && !isString(reason)) ||
    !isFiniteNumber(value.windowHours) ||
    !isFiniteNumber(value.totalRequests) ||
    !isFiniteNumber(value.totalBytes) ||
    !isFiniteNumber(value.cacheableRequests) ||
    !isFiniteNumber(value.cacheHits) ||
    !isFiniteNumber(value.cachedBytes)
  ) {
    return undefined;
  }

  const statuses = decodeCacheStatusSlices(value.statuses);
  const surfaces = decodeSurfaceCacheStats(value.surfaces);

  if (statuses === undefined || surfaces === undefined) {
    return undefined;
  }

  return {
    ok: value.ok,
    reason,
    fetchedAt: value.fetchedAt,
    windowHours: value.windowHours,
    statuses,
    surfaces,
    totalRequests: value.totalRequests,
    totalBytes: value.totalBytes,
    cacheableRequests: value.cacheableRequests,
    cacheHits: value.cacheHits,
    cachedBytes: value.cachedBytes,
  };
};

let zoneTagCache: string | null = null;

const resolveZoneTag = Effect.fnUntraced(function* (
  apiToken: string,
): Effect.fn.Return<string, AdminError> {
  if (zoneTagCache !== null) {
    return zoneTagCache;
  }

  const response = yield* tryPromise(() =>
    platformFetch(`${REST_URL}/zones?name=${encodeURIComponent(ZONE_NAME)}`, {
      headers: {
        authorization: `Bearer ${apiToken}`,
        "user-agent": manifoldUserAgent("admin"),
      },
    }),
  );

  if (!response.ok) {
    return yield* new AdminError({ message: `zone lookup HTTP ${response.status}` });
  }

  const payload = yield* tryPromise<unknown>(() => response.json());

  if (!isJsonObject(payload) || Array.isArray(payload) || !isJsonArray(payload.result)) {
    return yield* new AdminError({ message: "zone lookup returned an unexpected shape" });
  }

  const zone = payload.result.find(isJsonObject);

  if (!isJsonObject(zone) || !isString(zone.id)) {
    return yield* new AdminError({
      message: `zone ${ZONE_NAME} not visible to the analytics token`,
    });
  }

  zoneTagCache = zone.id;

  return zone.id;
});

const matchSurface = (path: string): { surface: string; pathPrefix: string } =>
  SURFACE_PREFIXES.find(
    ({ pathPrefix }) =>
      pathPrefix === "/" || path === pathPrefix || path.startsWith(`${pathPrefix}/`),
  ) ?? DOCS_SURFACE;

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

const fetchCacheSnapshot = Effect.fnUntraced(function* (): Effect.fn.Return<CacheSnapshot> {
  const now = DateTime.nowUnsafe();
  const fetchedAt = DateTime.formatIso(now);

  return yield* Effect.gen(function* () {
    const { env } = yield* workersRuntime();
    const apiToken = yield* resolveSecret(env.MANIFOLD_ADMIN_PANEL_ANALYTICS_API);

    if (!apiToken) {
      return emptyCacheSnapshot(
        "MANIFOLD_ADMIN_PANEL_ANALYTICS_API binding is not configured",
        fetchedAt,
      );
    }

    const zoneTag = yield* resolveZoneTag(apiToken);

    const data = yield* runGraphQL(
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
        since: sinceIso(now, CACHE_WINDOW_HOURS),
        host: PUBLIC_HOSTNAME,
      },
      decodeCacheRows,
    );

    const { totals, paths: pathRows } = data;

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
      const { surface } = matchSurface(row.dimensions.clientRequestPath ?? "/");
      const stat = bySurface.get(surface);

      if (stat === undefined) {
        throw new Error(`Cache surface ${surface} is missing from SURFACE_PREFIXES`);
      }

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
  }).pipe(Effect.catch((error) => Effect.succeed(emptyCacheSnapshot(error.message, fetchedAt))));
});

export const getCacheSnapshot = createServerFn({ method: "GET" }).handler(() =>
  runHost(
    cachedJsonProgram("cache-snapshot:v1", decodeCacheSnapshot, () =>
      fetchCacheSnapshot().pipe(
        Effect.map((snapshot): ComputedSnapshot<CacheSnapshot> => ({
          value: snapshot,
          cacheable: snapshot.ok,
        })),
      ),
    ),
  ),
);
