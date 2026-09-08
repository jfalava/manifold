import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  decodeResponse,
  ListState,
  OpsListResponse,
  RegistryEntriesResponse,
  RegistryListEntry,
  RegistryListResponse,
  SyncOp,
} from "@manifold/contract";
import { errorMessage, isJsonObject, isJsonValue, type JsonValue } from "@manifold/json";

import {
  fetchAniListMangaEntries,
  type AniListEntry,
} from "@/anilist";
import { resolveAniListToken } from "@/anilist-auth";
import { resolveValue } from "@/env-resolve";
import {
  abortFrame,
  closeFrame,
  frameDetail,
  openFrame,
} from "@/ui";

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

const isAniListRegistryStatus = (
  status: string,
): status is AniListRegistryStatus => Object.hasOwn(ANILIST_TO_REGISTRY, status);

const registryStatusFor = (anilistStatus: string): string =>
  isAniListRegistryStatus(anilistStatus)
    ? ANILIST_TO_REGISTRY[anilistStatus]
    : anilistStatus.toLowerCase();

const mappedRegistryStatus = (
  anilistStatus: string,
): (typeof ANILIST_TO_REGISTRY)[AniListRegistryStatus] | undefined =>
  isAniListRegistryStatus(anilistStatus)
    ? ANILIST_TO_REGISTRY[anilistStatus]
    : undefined;

export interface ApiConfig {
  readonly origin: string;
  readonly token: string;
}

export const apiConfig = (
  originFlag: Option.Option<string>,
  tokenFlag: Option.Option<string>,
): ApiConfig => {
  const token = resolveValue(
    tokenFlag,
    "MANIFOLD_TOKEN"
  );
  if (!token) {throw new Error("Personal API token missing (MANIFOLD_TOKEN)");}
  const origin = resolveValue(originFlag, "MANIFOLD_API_ORIGIN") ?? DEFAULT_API_ORIGIN;
  return { origin: origin.replace(/\/$/, ""), token };
};

export const apiCall = async <A>(
  config: ApiConfig,
  path: string,
  method = "GET",
  body?: JsonValue,
  schema?: Schema.ConstraintDecoder<A>,
): Promise<A> => {
  const response = await fetch(`${config.origin}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
      ...(!(body === undefined) && { "content-type": "application/json" }),
    },
    ...(!(body === undefined) && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let raw: unknown = undefined;
  if (text.length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }
  }
  if (!response.ok) {
    const message =
      isJsonObject(raw) && raw.error !== undefined
        ? errorMessage(raw.error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (schema !== undefined) {
    if (raw !== undefined && !isJsonValue(raw)) {
      throw new Error(`Personal API response is not JSON (${path})`);
    }
    const parsed: JsonValue = raw === undefined ? null : raw;
    return decodeResponse(schema, parsed, path);
  }
  // SAFETY: untyped call sites trust wire until migrated
  return raw as A;
};

/** Registry list row (compat alias for contract RegistryListEntry). */
export type RegistryRow = RegistryListEntry;

export const registryByAnilistId = async (
  config: ApiConfig
): Promise<Map<string, RegistryRow>> => {
  const PAGE_SIZE = 5000;
  let offset = 0;
  let page: readonly RegistryRow[];
  const all: RegistryRow[] = [];
  do {
    const body = await apiCall(
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
    if (link) {map.set(link.externalId, row);}
  }
  return map;
};

const anilistTokenFlag = Flag.string("anilist-token").pipe(
  Flag.optional,
  Flag.withDescription(
    "AniList access token override. Prefer anilist login (keychain) or MANIFOLD_ANILIST_TOKEN.",
  ),
);

const apiOriginFlag = Flag.string("api-origin").pipe(
  Flag.optional,
  Flag.withDescription(`Personal API origin (default ${DEFAULT_API_ORIGIN}).`)
);

const apiTokenFlag = Flag.string("api-token").pipe(
  Flag.optional,
  Flag.withDescription("Falls back to MANIFOLD_TOKEN.")
);

// ------------------------------------------------------------------
// ops — inspect and retry the op log.
// ------------------------------------------------------------------

export const opsCommand = Command.make("ops").pipe(
  Command.withDescription("Inspect the personal API op log."),
  Command.withSubcommands([
    Command.make("pending", {
      apiOrigin: apiOriginFlag,
      apiToken: apiTokenFlag,
    }).pipe(
      Command.withDescription("List pending / failed / blocked ops."),
      Command.withHandler(({ apiOrigin, apiToken }) =>
        Effect.tryPromise({
          try: async () => {
            openFrame("ops pending");
            try {
              const config = apiConfig(apiOrigin, apiToken);
              let total = 0;
              for (const state of ["pending", "failed", "blocked"] as const) {
                const body = await apiCall(
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
                  if (op.lastError) {frameDetail(`    └ ${op.lastError}`);}
                }
                total += body.ops.length;
              }
              closeFrame(`Listed ${total} ops`);
            } catch (error) {
              abortFrame();
              throw error;
            }
          },
          catch: (cause) => new Error(errorMessage(cause)),
        }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
      ),
    ),
    Command.make("retry", {
      opId: Flag.string("op-id").pipe(Flag.withDescription("The op_id to reset to pending.")),
      apply: Flag.boolean("apply").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Reset the op remotely (default: dry-run)."),
      ),
      apiOrigin: apiOriginFlag,
      apiToken: apiTokenFlag,
    }).pipe(
      Command.withDescription("Reset one op back to pending."),
      Command.withHandler(({ opId, apply, apiOrigin, apiToken }) =>
        Effect.tryPromise({
          try: async () => {
            openFrame("ops retry");
            try {
              if (!apply) {
                closeFrame(`Dry run: would reset ${opId} to pending. Re-run with --apply.`);
                return;
              }
              const config = apiConfig(apiOrigin, apiToken);
              await apiCall(
                config,
                `/v1/ops/${encodeURIComponent(opId)}/retry`,
                "POST",
                undefined,
                SyncOp,
              );
              closeFrame(`reset to pending: ${opId}`);
            } catch (error) {
              abortFrame();
              throw error;
            }
          },
          catch: (cause) => new Error(errorMessage(cause)),
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
    Effect.tryPromise({
      try: async () => {
        openFrame("reconcile diff");
        try {
          const token = await resolveAniListToken(Option.getOrUndefined(anilistToken));
          if (!token) {
            throw new Error(
              "AniList token missing: run anilist login, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN",
            );
          }
          const config = apiConfig(apiOrigin, apiToken);

          const live: readonly AniListEntry[] = await fetchAniListMangaEntries(token);
          const registry = await registryByAnilistId(config);

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
        } catch (error) {
          abortFrame();
          throw error;
        }
      },
      catch: (cause) => new Error(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);

// ------------------------------------------------------------------
// registry import — snapshot the live AniList list into the registry.
// ------------------------------------------------------------------

export const importCommand = Command.make("import", {
  anilistToken: anilistTokenFlag,
  apply: Flag.boolean("apply").pipe(
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
    Effect.tryPromise({
      try: async () => {
        openFrame("registry import");
        try {
          const token = await resolveAniListToken(Option.getOrUndefined(anilistToken));
          if (!token) {
            throw new Error(
              "AniList token missing: run anilist login, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN",
            );
          }

          const live = await fetchAniListMangaEntries(token);
          frameDetail(`fetched ${live.length} AniList entries`);
          if (!apply) {
            const importable = live.filter((entry) => mappedRegistryStatus(entry.status) !== undefined);
            closeFrame(
              `Dry run: would import ${importable.length}/${live.length} rows. Re-run with --apply.`,
            );
            return;
          }

          const config = apiConfig(apiOrigin, apiToken);

          const resolved = await apiCall(
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
            if (!entry || !row || !status) {continue;}
            await apiCall(
              config,
              `/v1/entries/${encodeURIComponent(row.id)}/list-state`,
              "POST",
              { status, origin: "migration", appliedRemotely: true },
              ListState,
            );
            imported += 1;
          }
          closeFrame(`registry import complete: ${imported}/${live.length} rows updated`);
        } catch (error) {
          abortFrame();
          throw error;
        }
      },
      catch: (cause) => new Error(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
