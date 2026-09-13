/** @effect-diagnostics asyncFunction:off */
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { ListrTask } from "listr2";
import { createAniListSource } from "@manifold/canonical/sources";
import { RegistryEntry, RegistryListResponse, type RegistryListEntry } from "@manifold/contract";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import { apiCall, apiConfig } from "@/commands/toolbox";
import {
  abortFrame,
  closeFrame,
  createRun,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import { cliError, platformFetch, runHost, sleepPromise } from "@/effect-kit";

/** AniList is currently degraded to 30 requests/minute; keep a safety margin. */
const ANILIST_LOOKUP_INTERVAL_MS = 2_500;

interface MalPrefillCtx extends RunContext {
  rows: RegistryListEntry[];
  selected: RegistryListEntry[];
  details: string[];
  linked: number;
  unmatched: number;
  errors: number;
}

export const malPrefillCommand = Command.make("mal", {
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Persist verified MAL links. Default: read-only audit."),
  ),
  limit: Flag.Int("limit").pipe(
    Flag.optional,
    Flag.withDescription("Maximum missing links to look up. Default: all."),
  ),
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Audit and backfill MAL links from AniList idMal. Never changes list state or title-matches.",
  ),
  Command.withHandler(({ apply, limit, apiOrigin, apiToken }) =>
    Effect.tryPromise({
      try: async () => {
        const maximum = Option.getOrUndefined(limit);
        if (maximum !== undefined && maximum < 0) {
          throw cliError("--limit must be non-negative");
        }
        const config = apiConfig(apiOrigin, apiToken);
        const source = createAniListSource({
          userAgent: manifoldUserAgent("cli"),
          fetcher: (input, init) =>
            platformFetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
        });
        openFrame(`MAL registry links (${apply ? "apply" : "dry run"})`);

        const loadTask: ListrTask<MalPrefillCtx> = {
          title: "Load registry rows",
          task: async (ctx, task) => {
            const pageSize = 5000;
            let offset = 0;
            const rows: RegistryListEntry[] = [];
            for (;;) {
              const page = await apiCall(
                config,
                `/v1/registry?limit=${pageSize}&offset=${offset}`,
                "GET",
                undefined,
                RegistryListResponse,
              );
              rows.push(...page.entries.filter((row) => !row.tombstoned));
              offset += page.entries.length;
              if (page.entries.length < pageSize) {
                break;
              }
            }
            const missing = rows.filter(
              (row) => !row.providers.some((link) => link.provider === "mal"),
            );
            const eligible = missing.filter((row) =>
              row.providers.some((link) => link.provider === "anilist"),
            );
            const selected = maximum === undefined ? eligible : eligible.slice(0, maximum);
            ctx.rows = rows;
            ctx.selected = selected;
            makePhaseReporter(task).note(
              `❖ ${rows.length} active; ${rows.length - missing.length} MAL-linked; ${missing.length} missing; ${missing.length - eligible.length} without AniList; ${selected.length} to check` +
                (maximum !== undefined ? ` (showing first ${selected.length})` : ""),
            );
          },
          rendererOptions: { outputBar: Infinity },
        };

        const sweepTask: ListrTask<MalPrefillCtx> = {
          title: `${apply ? "Check and link" : "Check"} MAL links`,
          task: async (ctx, task) => {
            const baseTitle = task.title;
            const reporter = makePhaseReporter(task);
            const total = ctx.selected.length;
            const counts = (): readonly [string, number][] => [
              [apply ? "linked" : "verified", ctx.linked],
              ["unmapped", ctx.unmatched],
              ["errors", ctx.errors],
            ];
            const done = (): number => ctx.linked + ctx.unmatched + ctx.errors;
            const formatTitle = (rowTitle: string, suffix = ""): string => {
              const cols = process.stdout.columns ?? 80;
              const budget = Math.max(
                24,
                Math.min(48, cols - baseTitle.length - 16 - suffix.length),
              );
              const clean = rowTitle.replace(/\s+/g, " ").trim();
              const short = clean.length > budget ? `${clean.slice(0, budget - 1)}…` : clean;
              return suffix ? `${short}${suffix}` : short;
            };
            const owners = new Map(
              ctx.rows.flatMap((row) =>
                row.providers
                  .filter((link) => link.provider === "mal")
                  .map((link) => [link.externalId, row.id] as const),
              ),
            );
            if (total > 0) {
              reporter.progress(0, total, counts());
            }

            for (const [index, row] of ctx.selected.entries()) {
              if (index > 0) {
                await sleepPromise(ANILIST_LOOKUP_INTERVAL_MS);
              }
              task.title = `${baseTitle} — ${formatTitle(row.title)}`;
              const anilistId = row.providers.find((link) => link.provider === "anilist")?.externalId;
              if (!anilistId) {
                continue;
              }
              try {
                const canonical = await runHost(source.getById(anilistId));
                const malId = canonical?.externalIds?.mal;
                if (!malId) {
                  ctx.unmatched += 1;
                  ctx.details.push(`UNMAPPED ${row.id} anilist:${anilistId}`);
                  task.title = `${baseTitle} — ${formatTitle(row.title, " — unmapped")}`;
                  reporter.progress(done(), total, counts());
                  continue;
                }
                if (canonical?.providerId !== anilistId || !/^[1-9]\d*$/.test(malId)) {
                  throw cliError("Invalid AniList cross-link response");
                }
                const owner = owners.get(malId);
                if (owner && owner !== row.id) {
                  throw cliError(`mal:${malId} already belongs to ${owner}`);
                }
                if (apply) {
                  // Ingestion rejects conflicting ownership; linkProvider would move the link.
                  await apiCall(
                    config,
                    "/v1/registry/ingest",
                    "POST",
                    {
                      provider: "anilist",
                      providerId: anilistId,
                      title: row.title,
                      links: [{ provider: "mal", externalId: malId }],
                    },
                    RegistryEntry,
                  );
                }
                owners.set(malId, row.id);
                ctx.linked += 1;
                ctx.details.push(
                  `${apply ? "LINKED" : "WOULD LINK"} ${row.id} anilist:${anilistId} → mal:${malId}`,
                );
                task.title = `${baseTitle} — ${formatTitle(row.title, ` → mal:${malId}`)}`;
              } catch (error) {
                ctx.errors += 1;
                ctx.details.push(`ERROR ${row.id}: ${errorMessage(error)}`);
                task.title = `${baseTitle} — ${formatTitle(row.title, " — error")}`;
              }
              reporter.progress(done(), total, counts());
            }
            task.title = baseTitle;
            reporter.note(
              [
                `❖ ${apply ? "Applied" : "Dry run"}: ${ctx.linked} ${apply ? "linked" : "verified"} · ${ctx.unmatched} unmapped · ${ctx.errors} errors.`,
                ...(ctx.details.length > 0 ? ctx.details : []),
                ...(apply ? [] : ["Re-run with --apply to write."]),
              ].join("\n"),
            );
          },
          rendererOptions: { outputBar: 1, persistentOutput: true },
        };

        const run = createRun<MalPrefillCtx>([loadTask, sweepTask]);
        const ctx: MalPrefillCtx = {
          rows: [],
          selected: [],
          details: [],
          linked: 0,
          unmatched: 0,
          errors: 0,
        };
        try {
          await run.run(ctx);
          closeFrame(
            `${ctx.linked} ${apply ? "linked" : "verified"}; ${ctx.unmatched} unmapped; ${ctx.errors} errors`,
          );
          if (ctx.errors > 0) {
            throw cliError(`${ctx.errors} MAL link checks failed; inspect the report and rerun`);
          }
        } catch (error) {
          abortFrame();
          throw error;
        }
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }),
  ),
);
