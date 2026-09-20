import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  decodeResponse,
  ListState,
  OpsListResponse,
  OpsSummaryResponse,
  RegistryEntriesResponse,
  RegistryListEntry,
  RegistryListResponse,
  SyncOp,
  UpdatedCountResponse,
} from "@manifold/contract";
import {
  errorMessage,
  isJsonObject,
  isJsonValue,
  manifoldUserAgent,
  type JsonValue,
} from "@manifold/json";

import { fetchAniListMangaEntries, type AniListEntry } from "@/anilist";
import {
  drainAniListOpsPassEffect,
  type DrainApiClient,
  type PendingAniListOp,
} from "@/anilist-drain";
import { resolveAniListToken } from "@/login/anilist";
import {
  loadManifoldSession,
  refreshManifoldSession,
  type ManifoldSession,
} from "@/login/manifold";
import { resolveValue } from "@/env-resolve";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import {
  cliError,
  decodeJsonOption,
  epochMillisNow,
  fromPromise,
  jsonBodyString,
  platformFetch,
  runHost,
  sleep,
  type CliEffectError,
} from "@/effect-kit";

const DEFAULT_API_ORIGIN = "https://manifold.jfa.dev/api";

const ANILIST_TO_REGISTRY = {
  CURRENT: "reading",
  PLANNING: "plan_to_read",
  PAUSED: "on_hold",
  DROPPED: "dropped",
  COMPLETED: "completed",
  REPEATING: "re_reading",
} as const;

type AniListRegistryStatus = keyof typeof ANILIST_TO_REGISTRY;

const isAniListRegistryStatus = (status: string): status is AniListRegistryStatus =>
  Object.hasOwn(ANILIST_TO_REGISTRY, status);

const registryStatusFor = (anilistStatus: string): string =>
  isAniListRegistryStatus(anilistStatus)
    ? ANILIST_TO_REGISTRY[anilistStatus]
    : anilistStatus.toLowerCase();

const mappedRegistryStatus = (
  anilistStatus: string,
): (typeof ANILIST_TO_REGISTRY)[AniListRegistryStatus] | undefined =>
  isAniListRegistryStatus(anilistStatus) ? ANILIST_TO_REGISTRY[anilistStatus] : undefined;

export interface ApiConfig {
  readonly origin: string;
  token: string;
  refreshToken?: string;
  accessExpiresAt?: number;
}

const apiConfigEffect = (
  originFlag: Option.Option<string>,
  tokenFlag: Option.Option<string>,
): Effect.Effect<ApiConfig, CliEffectError> =>
  Effect.gen(function* () {
    const token = resolveValue(tokenFlag, "MANIFOLD_TOKEN");
    const origin = resolveValue(originFlag, "MANIFOLD_API_ORIGIN") ?? DEFAULT_API_ORIGIN;
    if (token) {
      return { origin: origin.replace(/\/$/, ""), token };
    }
    const session = yield* fromPromise(() => loadManifoldSession());
    if (!session) {
      return yield* cliError("Manifold session missing: run login manifold or set MANIFOLD_TOKEN");
    }
    return {
      origin: origin.replace(/\/$/, ""),
      token: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: session.expiresAt,
    };
  });

export const apiConfig = (
  originFlag: Option.Option<string>,
  tokenFlag: Option.Option<string>,
): Promise<ApiConfig> => runHost(apiConfigEffect(originFlag, tokenFlag));

const apiCallEffect = <A>(
  config: ApiConfig,
  path: string,
  method = "GET",
  body?: JsonValue,
  schema?: Schema.ConstraintDecoder<A>,
): Effect.Effect<A, CliEffectError> =>
  Effect.gen(function* () {
    const request = (token: string) =>
      Effect.gen(function* () {
        const response = yield* fromPromise(() =>
          platformFetch(`${config.origin}${path}`, {
            method,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              "user-agent": manifoldUserAgent("cli"),
              ...(!(body === undefined) && { "content-type": "application/json" }),
            },
            ...(!(body === undefined) && { body: jsonBodyString(body) }),
          }),
        );
        const text = yield* fromPromise(() => response.text());
        const parsed =
          text.length > 0
            ? Option.getOrUndefined(decodeJsonOption(Schema.fromJsonString(Schema.Unknown), text))
            : undefined;
        const raw: JsonValue | undefined =
          parsed !== undefined && isJsonValue(parsed) ? parsed : text.length > 0 ? text : undefined;
        return { response, raw };
      });

    const refresh = () =>
      fromPromise(() =>
        refreshManifoldSession(config.origin, {
          accessToken: config.token,
          refreshToken: config.refreshToken!,
          expiresAt: config.accessExpiresAt ?? 0,
        } satisfies ManifoldSession),
      );
    if (
      config.refreshToken &&
      config.accessExpiresAt !== undefined &&
      config.accessExpiresAt <= epochMillisNow() + 30_000
    ) {
      const refreshed = yield* refresh();
      config.token = refreshed.accessToken;
      config.refreshToken = refreshed.refreshToken;
      config.accessExpiresAt = refreshed.expiresAt;
    }
    let result = yield* request(config.token);
    if (result.response.status === 401 && config.refreshToken) {
      const refreshed = yield* refresh();
      config.token = refreshed.accessToken;
      config.refreshToken = refreshed.refreshToken;
      config.accessExpiresAt = refreshed.expiresAt;
      result = yield* request(config.token);
    }
    const { response, raw } = result;
    if (!response.ok) {
      const message =
        isJsonObject(raw) && raw.error !== undefined
          ? errorMessage(raw.error)
          : `HTTP ${response.status}`;
      return yield* cliError(message);
    }
    if (schema !== undefined) {
      if (raw !== undefined && !isJsonValue(raw)) {
        return yield* cliError(`Personal API response is not JSON (${path})`);
      }
      const decoded: JsonValue = raw === undefined ? null : raw;
      return yield* Effect.try({
        try: () => decodeResponse(schema, decoded, path),
        catch: (cause) => cliError(errorMessage(cause)),
      });
    }
    // SAFETY: untyped call sites trust wire until migrated
    return raw as A;
  });

export const apiCall = <A>(
  config: ApiConfig,
  path: string,
  method = "GET",
  body?: JsonValue,
  schema?: Schema.ConstraintDecoder<A>,
): Promise<A> => runHost(apiCallEffect(config, path, method, body, schema));

/** Registry list row (compat alias for contract RegistryListEntry). */
export type RegistryRow = RegistryListEntry;

const registryByAnilistIdEffect = (
  config: ApiConfig,
): Effect.Effect<Map<string, RegistryRow>, CliEffectError> =>
  Effect.gen(function* () {
    const PAGE_SIZE = 5000;
    let offset = 0;
    let page: readonly RegistryRow[];
    const all: RegistryRow[] = [];
    do {
      const body = yield* apiCallEffect(
        config,
        `/v1/registry?limit=${PAGE_SIZE}&offset=${offset}`,
        "GET",
        undefined,
        RegistryListResponse,
      );
      page = body.entries;
      all.push(...page);
      offset += page.length;
    } while (page.length === PAGE_SIZE);
    const map = new Map<string, RegistryRow>();
    for (const row of all) {
      const link = row.providers.find((provider) => provider.provider === "anilist");
      if (link) {
        map.set(link.externalId, row);
      }
    }
    return map;
  });

export const registryByAnilistId = (config: ApiConfig): Promise<Map<string, RegistryRow>> =>
  runHost(registryByAnilistIdEffect(config));

const anilistTokenFlag = Flag.String("anilist-token").pipe(
  Flag.optional,
  Flag.withDescription(
    "AniList access token override. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
  ),
);

const apiOriginFlag = Flag.String("api-origin").pipe(
  Flag.optional,
  Flag.withDescription(`Personal API origin (default ${DEFAULT_API_ORIGIN}).`),
);

const apiTokenFlag = Flag.String("api-token").pipe(
  Flag.optional,
  Flag.withDescription("Falls back to MANIFOLD_TOKEN."),
);

// ------------------------------------------------------------------
// ops — inspect and retry the op log.
// ------------------------------------------------------------------

const drainApiClient = (config: ApiConfig): DrainApiClient => ({
  pendingAniListOps: (limit = 25) =>
    runHost(
      Effect.gen(function* () {
        const body = yield* apiCallEffect(
          config,
          `/v1/ops/pending/anilist?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`,
          "GET",
          undefined,
          OpsListResponse,
        );
        return body.ops.map(
          (op): PendingAniListOp => ({
            opId: op.opId,
            kind: op.kind,
            payload: op.payload,
            attempts: op.attempts,
          }),
        );
      }),
    ),
  completeOps: (results) =>
    runHost(
      apiCallEffect(config, "/v1/ops/complete", "POST", { results }, UpdatedCountResponse),
    ),
});

const DEFAULT_DRAIN_INTERVAL_SEC = 30;

export const opsCommand = Command.make("ops").pipe(
  Command.withDescription("Inspect the personal API op log."),
  Command.withSubcommands([
    Command.make("pending", {
      apiOrigin: apiOriginFlag,
      apiToken: apiTokenFlag,
    }).pipe(
      Command.withDescription("List pending / failed / blocked ops."),
      Command.withHandler(({ apiOrigin, apiToken }) =>
        Effect.gen(function* () {
          openFrame("ops pending");
          const config = yield* fromPromise(() => apiConfig(apiOrigin, apiToken));
          let total = 0;
          for (const state of ["pending", "failed", "blocked"] as const) {
            const body = yield* apiCallEffect(
              config,
              `/v1/ops?state=${state}&limit=200`,
              "GET",
              undefined,
              OpsListResponse,
            );
            frameDetail(`${state}: ${body.ops.length}`);
            for (const op of body.ops) {
              frameDetail(
                `  ${state.toUpperCase()} ${op.opId} ${op.kind} origin=${op.origin} attempts=${op.attempts}`,
              );
              if (op.lastError) {
                frameDetail(`    └ ${op.lastError}`);
              }
            }
            total += body.ops.length;
          }
          // The shelf mirror queue has no op rows; its DLQ state rides on
          // the summary endpoint.
          const { summary } = yield* apiCallEffect(
            config,
            "/v1/ops/summary?limit=200",
            "GET",
            undefined,
            OpsSummaryResponse,
          );
          if (summary.shelfPending > 0 || summary.shelfBlocked > 0) {
            frameDetail(`shelf: pending=${summary.shelfPending} blocked=${summary.shelfBlocked}`);
            if (summary.shelfLastBlockedError) {
              frameDetail(`  └ ${summary.shelfLastBlockedError}`);
            }
          }
          closeFrame(`Listed ${total} ops`);
        }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
      ),
    ),
    Command.make("retry", {
      opId: Flag.String("op-id").pipe(Flag.withDescription("The op_id to reset to pending.")),
      apply: Flag.Boolean("apply").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Reset the op remotely (default: dry-run)."),
      ),
      apiOrigin: apiOriginFlag,
      apiToken: apiTokenFlag,
    }).pipe(
      Command.withDescription("Reset one op back to pending."),
      Command.withHandler(({ opId, apply, apiOrigin, apiToken }) =>
        Effect.gen(function* () {
          openFrame("ops retry");
          if (!apply) {
            closeFrame(`Dry run: would reset ${opId} to pending. Re-run with --apply.`);
            return;
          }
          const config = yield* fromPromise(() => apiConfig(apiOrigin, apiToken));
          yield* apiCallEffect(
            config,
            `/v1/ops/${encodeURIComponent(opId)}/retry`,
            "POST",
            undefined,
            SyncOp,
          );
          closeFrame(`reset to pending: ${opId}`);
        }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
      ),
    ),
    Command.make("drain-anilist", {
      once: Flag.Boolean("once").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Run a single drain pass and exit (default: loop)."),
      ),
      interval: Flag.Int("interval").pipe(
        Flag.withDefault(DEFAULT_DRAIN_INTERVAL_SEC),
        Flag.withDescription(
          `Seconds between passes when looping (default ${DEFAULT_DRAIN_INTERVAL_SEC}).`,
        ),
      ),
      limit: Flag.Int("limit").pipe(
        Flag.withDefault(25),
        Flag.withDescription("Max pending anilist:* ops per pass (default 25, max 100)."),
      ),
      anilistToken: anilistTokenFlag,
      apiOrigin: apiOriginFlag,
      apiToken: apiTokenFlag,
    }).pipe(
      Command.withDescription(
        "Drain pending anilist:* ops via local AniList GraphQL (non-CF egress). For oci-agents / always-on hosts.",
      ),
      Command.withHandler(({ once, interval, limit, anilistToken, apiOrigin, apiToken }) =>
        Effect.gen(function* () {
          openFrame(once ? "ops drain-anilist (once)" : "ops drain-anilist");
          const config = yield* fromPromise(() => apiConfig(apiOrigin, apiToken));
          const token = yield* fromPromise(() =>
            resolveAniListToken(Option.getOrUndefined(anilistToken)),
          );
          if (!token) {
            return yield* cliError(
              "Missing AniList token: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.",
            );
          }
          if (!Number.isFinite(interval) || interval < 1) {
            return yield* cliError("--interval must be a positive integer (seconds).");
          }
          if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
            return yield* cliError("--limit must be between 1 and 100.");
          }

          const api = drainApiClient(config);
          let passes = 0;

          const onePass = (): Effect.Effect<void, CliEffectError> =>
            Effect.gen(function* () {
              const summary = yield* drainAniListOpsPassEffect(api, token, { limit });
              passes += 1;
              if (summary.fetched === 0) {
                frameDetail(`pass ${passes}: idle (no pending anilist ops)`);
              } else {
                frameDetail(
                  `pass ${passes}: fetched=${summary.fetched} ok=${summary.ok} failed=${summary.failed} reported=${summary.reported}`,
                );
              }
            });

          if (once) {
            yield* onePass();
            closeFrame(`drain-anilist once complete (${passes} pass)`);
            return;
          }

          frameDetail(
            `looping every ${interval}s (Ctrl+C to stop). AniList stays on this host's egress IP.`,
          );
          // Long-running unit: never close the frame; journald captures stdout.
          for (;;) {
            const passResult = yield* onePass().pipe(
              Effect.map(() => ({ ok: true as const })),
              Effect.catch((cause) =>
                Effect.sync(() => {
                  frameDetail(`pass error: ${errorMessage(cause)}`);
                  return { ok: false as const };
                }),
              ),
            );
            void passResult;
            yield* sleep(interval * 1000);
          }
        }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
      ),
    ),
  ]),
);

// ------------------------------------------------------------------
// reconcile diff — AniList live list vs the registry projection.
// ------------------------------------------------------------------

export const reconcileCommand = Command.make("diff", {
  anilistToken: anilistTokenFlag,
  apiOrigin: apiOriginFlag,
  apiToken: apiTokenFlag,
}).pipe(
  Command.withDescription(
    "Compare the live AniList manga list against the registry's recorded list state. Read-only.",
  ),
  Command.withHandler(({ anilistToken, apiOrigin, apiToken }) =>
    Effect.gen(function* () {
      openFrame("reconcile diff");
      const token = yield* fromPromise(() =>
        resolveAniListToken(Option.getOrUndefined(anilistToken)),
      );
      if (!token) {
        return yield* cliError(
          "AniList token missing: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN",
        );
      }
      const config = yield* fromPromise(() => apiConfig(apiOrigin, apiToken));

      const live: readonly AniListEntry[] = yield* fromPromise(() =>
        fetchAniListMangaEntries(token),
      );
      const registry = yield* registryByAnilistIdEffect(config);

      let drift = 0;
      let missing = 0;
      for (const entry of live) {
        const status = registryStatusFor(entry.status);
        const key = String(entry.mediaId);
        const row = registry.get(key);
        if (!row) {
          missing += 1;
          frameDetail(`NOT IN REGISTRY anilist:${key} ${entry.title}`);
          continue;
        }
        if ((row.state?.status ?? "(none)") !== status) {
          drift += 1;
          frameDetail(
            `DRIFT anilist:${key} ${row.title}: anilist=${status} registry=${row.state?.status ?? "(none)"}`,
          );
        }
      }
      closeFrame(
        `compared ${live.length} AniList entries against ${registry.size} registry rows; ${drift} drifted, ${missing} unregistered`,
      );
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);

// ------------------------------------------------------------------
// registry import — snapshot the live AniList list into the registry.
// ------------------------------------------------------------------

export const importCommand = Command.make("import", {
  anilistToken: anilistTokenFlag,
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Write imported rows and list state to the registry (default: dry-run)."),
  ),
  apiOrigin: apiOriginFlag,
  apiToken: apiTokenFlag,
}).pipe(
  Command.withDescription(
    "Backfill: mint registry rows for every live AniList manga entry and record its status (no ops enqueued — AniList already holds this state).",
  ),
  Command.withHandler(({ anilistToken, apply, apiOrigin, apiToken }) =>
    Effect.gen(function* () {
      openFrame("registry import");
      const token = yield* fromPromise(() =>
        resolveAniListToken(Option.getOrUndefined(anilistToken)),
      );
      if (!token) {
        return yield* cliError(
          "AniList token missing: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN",
        );
      }

      const live = yield* fromPromise(() => fetchAniListMangaEntries(token));
      frameDetail(`fetched ${live.length} AniList entries`);
      if (!apply) {
        const importable = live.filter((entry) => mappedRegistryStatus(entry.status) !== undefined);
        closeFrame(
          `Dry run: would import ${importable.length}/${live.length} rows. Re-run with --apply.`,
        );
        return;
      }

      const config = yield* fromPromise(() => apiConfig(apiOrigin, apiToken));

      const resolved = yield* apiCallEffect(
        config,
        "/v1/canonical/resolve-batch",
        "POST",
        live.map((entry) => ({
          provider: "anilist",
          providerId: String(entry.mediaId),
          title: entry.title,
        })),
        RegistryEntriesResponse,
      );

      let imported = 0;
      for (let index = 0; index < live.length; index += 1) {
        const entry = live[index];
        const row = resolved.entries[index];
        const status = entry ? mappedRegistryStatus(entry.status) : undefined;
        if (!entry || !row || !status) {
          continue;
        }
        yield* apiCallEffect(
          config,
          `/v1/entries/${encodeURIComponent(row.id)}/list-state`,
          "POST",
          { status, origin: "migration", appliedRemotely: true },
          ListState,
        );
        imported += 1;
      }
      closeFrame(`registry import complete: ${imported}/${live.length} rows updated`);
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
