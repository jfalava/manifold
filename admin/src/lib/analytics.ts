import { manifoldUserAgent } from "@manifold/json";
import { createServerFn } from "@tanstack/react-start";
import { DateTime, Effect } from "effect";

import { AdminError, platformFetch, runHost, tryPromise, workersRuntime } from "./effect-host";
import {
  isBooleanValue,
  isFunctionValue,
  isJsonArray,
  isJsonObject,
  isNumberValue,
  isSecretHandleObject,
  isStringValue,
  type JsonValue,
  type JsonObject,
  type SecretHandle,
} from "./guards";
import { cachedJsonProgram, type ComputedSnapshot } from "./server-cache";

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

interface CacheRows {
  totals: CacheStatusRow[];
  paths: CacheStatusRow[];
}

const isRecord = (value: unknown): value is JsonObject =>
  isJsonObject(value) && !Array.isArray(value);

const isFiniteValue = (value: unknown): value is number =>
  isNumberValue(value) && Number.isFinite(value);

const accountRows = (data: JsonObject, key: string): readonly JsonObject[] | undefined => {
  const viewer = isRecord(data.viewer) ? data.viewer : undefined;
  const accounts = viewer?.accounts;
  if (!isJsonArray(accounts)) {
    return undefined;
  }
  const account = accounts[0];
  if (account === undefined) {
    return [];
  }
  if (!isRecord(account) || !isJsonArray(account[key]) || !account[key].every(isRecord)) {
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
    if (!isRecord(dimensions) || !isRecord(sum) || !isStringValue(dimensions.scriptName)) {
      return undefined;
    }
    const datetimeHour = dimensions.datetimeHour;
    if (datetimeHour !== undefined && datetimeHour !== null && !isStringValue(datetimeHour)) {
      return undefined;
    }
    if (!isNumberValue(sum.requests) || !isNumberValue(sum.errors)) {
      return undefined;
    }
    decoded.push({
      dimensions: {
        scriptName: dimensions.scriptName,
        ...(isStringValue(datetimeHour) && { datetimeHour }),
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
    if (!isRecord(sum) || !isNumberValue(sum.requests)) {
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
    if (!isRecord(max) || (max.storedBytes !== null && !isNumberValue(max.storedBytes))) {
      return undefined;
    }
    decoded.push({ max: { storedBytes: max.storedBytes === null ? null : max.storedBytes } });
  }
  return decoded;
};

const decodeCacheRows = (data: JsonObject): CacheRows | undefined => {
  const viewer = isRecord(data.viewer) ? data.viewer : undefined;
  const zones = viewer?.zones;
  if (!isJsonArray(zones)) {
    return undefined;
  }
  const zone = zones[0];
  if (zone === undefined) {
    return { totals: [], paths: [] };
  }
  if (!isRecord(zone)) {
    return undefined;
  }
  const decodeRows = (value: JsonValue | undefined): CacheStatusRow[] | undefined => {
    if (!isJsonArray(value) || !value.every(isRecord)) {
      return undefined;
    }
    const decoded: CacheStatusRow[] = [];
    for (const row of value) {
      const dimensions = row.dimensions;
      const sum = row.sum;
      if (!isRecord(dimensions) || !isRecord(sum) || !isNumberValue(row.count)) {
        return undefined;
      }
      const cacheStatus = dimensions.cacheStatus;
      const path = dimensions.clientRequestPath;
      if (
        (cacheStatus !== undefined && cacheStatus !== null && !isStringValue(cacheStatus)) ||
        (path !== undefined && path !== null && !isStringValue(path)) ||
        !isNumberValue(sum.edgeResponseBytes)
      ) {
        return undefined;
      }
      decoded.push({
        count: row.count,
        sum: { edgeResponseBytes: sum.edgeResponseBytes },
        dimensions: {
          cacheStatus: isStringValue(cacheStatus) ? cacheStatus : null,
          ...(isStringValue(path) && { clientRequestPath: path }),
        },
      });
    }
    return decoded;
  };
  const totals = decodeRows(zone.totals);
  const paths = decodeRows(zone.paths);
  return totals === undefined || paths === undefined ? undefined : { totals, paths };
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: cache decoder validates the persisted snapshot before use
const decodeAnalyticsSnapshot = (value: unknown): AnalyticsSnapshot | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const reason = value.reason;
  if (
    !isStringValue(value.fetchedAt) ||
    !isBooleanValue(value.ok) ||
    (reason !== null && !isStringValue(reason)) ||
    !isFiniteValue(value.totalRequests) ||
    !isFiniteValue(value.totalErrors) ||
    !isFiniteValue(value.doRequests) ||
    (value.doStoredBytes !== null && !isFiniteValue(value.doStoredBytes))
  ) {
    return undefined;
  }
  const workerTrafficValue = value.workerTraffic;
  if (!isRecord(workerTrafficValue)) {
    return undefined;
  }
  const workerTraffic: Partial<Record<LogicalWorker, WorkerTraffic>> = {};
  for (const [logical, traffic] of Object.entries(workerTrafficValue)) {
    const worker = LOGICAL_WORKERS.find((candidate) => candidate === logical);
    if (worker === undefined || !isRecord(traffic)) {
      return undefined;
    }
    if (!isFiniteValue(traffic.requests) || !isFiniteValue(traffic.errors)) {
      return undefined;
    }
    workerTraffic[worker] = {
      requests: traffic.requests,
      errors: traffic.errors,
    };
  }
  const hourlyValue = value.hourly;
  if (!isRecord(hourlyValue)) {
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
        !isRecord(point) ||
        !isStringValue(point.hour) ||
        !isFiniteValue(point.requests) ||
        !isFiniteValue(point.errors)
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: secret binding comes from untyped workers env; parsed at I/O boundary via isString/isSecretHandle
const resolveSecret = Effect.fnUntraced(function* (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Alchemy secret bindings are runtime handles; guards parse them before use
  binding: unknown,
): Effect.fn.Return<string | null, AdminError> {
  if (isStringValue(binding)) {
    return binding;
  }
  if (isSecretHandleObject(binding)) {
    const handle: SecretHandle = binding;
    if (isFunctionValue(handle.get)) {
      const value = yield* tryPromise(() => handle.get!());
      return isStringValue(value) ? value : null;
    }
    if (isStringValue(handle.value)) {
      return handle.value;
    }
  }
  return null;
});

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
      body: JSON.stringify({ query, variables }),
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
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: empty arrays are intentionally widened to HourlyPoint[]; no evidence discarded (no elements)
  return {
    ManifoldRouter: [],
    ManifoldApi: [],
    ManifoldDocs: [],
    "manifold-admin": [],
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

const decodeCacheStatusSlices = (value: JsonValue): CacheStatusSlice[] | undefined => {
  if (!isJsonArray(value)) {
    return undefined;
  }
  const statuses: CacheStatusSlice[] = [];
  for (const status of value) {
    if (
      !isRecord(status) ||
      !isStringValue(status.status) ||
      !isFiniteValue(status.requests) ||
      !isFiniteValue(status.bytes)
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

const decodeSurfaceCacheStats = (value: JsonValue): SurfaceCacheStat[] | undefined => {
  if (!isJsonArray(value)) {
    return undefined;
  }
  const surfaces: SurfaceCacheStat[] = [];
  for (const surface of value) {
    if (
      !isRecord(surface) ||
      !isStringValue(surface.surface) ||
      !isStringValue(surface.pathPrefix) ||
      !isFiniteValue(surface.requests) ||
      !isFiniteValue(surface.hits) ||
      !isFiniteValue(surface.misses) ||
      !isFiniteValue(surface.uncacheable) ||
      !isFiniteValue(surface.bytes)
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: cache decoder validates the persisted snapshot before use
const decodeCacheSnapshot = (value: unknown): CacheSnapshot | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const reason = value.reason;
  if (
    !isBooleanValue(value.ok) ||
    !isStringValue(value.fetchedAt) ||
    (reason !== null && !isStringValue(reason)) ||
    !isFiniteValue(value.windowHours) ||
    !isFiniteValue(value.totalRequests) ||
    !isFiniteValue(value.totalBytes) ||
    !isFiniteValue(value.cacheableRequests) ||
    !isFiniteValue(value.cacheHits) ||
    !isFiniteValue(value.cachedBytes)
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
  const zone = payload.result.find(isRecord);
  if (!isJsonObject(zone) || !isStringValue(zone.id)) {
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

const fetchCacheSnapshot = Effect.fnUntraced(function* (): Effect.fn.Return<CacheSnapshot> {
  const now = DateTime.nowUnsafe();
  const fetchedAt = DateTime.formatIso(now);

  return yield* Effect.gen(function* () {
    const { env } = yield* workersRuntime();
    const apiToken = yield* resolveSecret(env.MANIFOLD_ADMIN_PANEL_ANALYTICS_API);
    if (!isStringValue(apiToken) || apiToken === "") {
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
