import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { ListrTask } from "listr2";
import { errorMessage } from "@manifold/json";
import { resolveAniListToken } from "@/login/anilist";
import { loadRegistrySearchTitles } from "@/comix-aliases";
import { matchesStatusFilter, parseStatusFilter, STATUS_FILTER_HINT } from "@/registry-status";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import {
  MangaDexMatchResult,
  type MangaDexMatchResult as MangaDexMatchResultBody,
  RegistryEntry,
  RegistryListResponse,
} from "@manifold/contract";
import { apiCall, apiConfig, type ApiConfig, type RegistryRow } from "@/commands/toolbox";
import { sleepPromise } from "@/effect-kit";

const sleep = sleepPromise;

type FullRegistryRow = RegistryRow;

interface MangadexCtx extends RunContext {
  unmatched: FullRegistryRow[];
  linked: number;
  ambiguous: number;
  notFound: number;
  skipped: number;
  errors: number;
}

const providerIdFor = (
  row: FullRegistryRow,
): { provider: "anilist" | "mal"; providerId: string } | undefined => {
  const anilist = row.providers.find((p) => p.provider === "anilist")?.externalId;
  if (anilist) {
    return { provider: "anilist", providerId: anilist };
  }
  const mal = row.providers.find((p) => p.provider === "mal")?.externalId;
  if (mal) {
    return { provider: "mal", providerId: mal };
  }
  if (row.provider === "anilist" || row.provider === "mal") {
    return { provider: row.provider, providerId: row.providerId };
  }
  return undefined;
};

export const mangadexPrefillCommand = Command.make("mangadex", {
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Write links to the registry (default: dry-run)."),
  ),
  limit: Flag.Int("limit").pipe(
    Flag.optional,
    Flag.withDescription("Max entries to process this run (default: all unmatched)."),
  ),
  status: Flag.String("status").pipe(
    Flag.withDefault("auto"),
    Flag.withDescription(
      `Only prefill rows whose registry reading status matches. ${STATUS_FILTER_HINT}.`,
    ),
  ),
  delay: Flag.Int("delay").pipe(
    Flag.withDefault(800),
    Flag.withDescription("Delay between resolve calls in ms (default 800)."),
  ),
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
  anilistToken: Flag.String("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "Optional AniList access token override for English/romaji/native/synonym aliases. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Backfill mangadex provider links for registry rows. Delegates matching to the Worker's vector + live-search resolver (no local MangaDex secrets needed).",
  ),
  Command.withHandler(({ apply, limit, status, delay, apiOrigin, apiToken, anilistToken }) =>
    Effect.tryPromise({
      try: async () => {
        const config: ApiConfig = apiConfig(apiOrigin, apiToken);
        const statusFilter = parseStatusFilter(status);
        const anilist = await resolveAniListToken(Option.getOrUndefined(anilistToken));
        openFrame(`MangaDex registry prefill → ${apply ? "apply" : "dry run"}`);
        if (statusFilter) {
          frameDetail(`status filter: ${[...statusFilter].join(", ")}`);
        }
        if (anilist) {
          frameDetail("resolving with AniList english/romaji/native/synonyms");
        } else {
          frameDetail("no AniList login: resolving with the registry title only");
        }

        const limitValue = Option.getOrUndefined(limit);
        const delayMs = delay;

        const loadTask: ListrTask<MangadexCtx> = {
          title: "Load registry rows",
          task: async (ctx, task) => {
            // Full-registry prefill: the old LIMIT 500 hid ~2.1k rows.
            // Page through everything for this one-time backfill.
            const PAGE_SIZE = 5000;
            let offset = 0;
            let page: readonly FullRegistryRow[];
            const allRows: FullRegistryRow[] = [];
            do {
              const body = await apiCall(
                config,
                `/v1/registry?limit=${PAGE_SIZE}&offset=${offset}`,
                "GET",
                undefined,
                RegistryListResponse,
              );
              page = body.entries;
              allRows.push(...page);
              offset += page.length;
            } while (page.length === PAGE_SIZE);
            const all = allRows.filter((row) => !row.tombstoned);
            const withoutMangadex = all.filter(
              (row) => !row.providers.some((p) => p.provider === "mangadex"),
            );
            const statusMatched = withoutMangadex.filter((row) =>
              matchesStatusFilter(row.state?.status, statusFilter),
            );
            ctx.unmatched = statusMatched;
            if (limitValue !== undefined && limitValue >= 0) {
              ctx.unmatched = ctx.unmatched.slice(0, limitValue);
            }
            const statusNote =
              statusFilter === undefined
                ? ""
                : ` · ${statusMatched.length}/${withoutMangadex.length} match --status`;
            makePhaseReporter(task).note(
              `❖ ${all.length} active rows (paged, limit=${PAGE_SIZE}) · ${withoutMangadex.length} without a mangadex link${statusNote} → ${ctx.unmatched.length} to resolve` +
                (limitValue !== undefined ? ` (showing first ${ctx.unmatched.length})` : ""),
            );
          },
          rendererOptions: { outputBar: Infinity },
        };

        const sweepTask: ListrTask<MangadexCtx> = {
          title: `Resolve mangadex${apply ? " and link" : ""}`,
          task: async (ctx, task) => {
            const baseTitle = task.title;
            const reporter = makePhaseReporter(task);
            const total = ctx.unmatched.length;
            const counts = (): readonly [string, number][] => [
              ["linked", ctx.linked],
              ["ambiguous", ctx.ambiguous],
              ["not_found", ctx.notFound],
              ["skipped", ctx.skipped],
              ["error", ctx.errors],
            ];
            const done = (): number =>
              ctx.linked + ctx.ambiguous + ctx.notFound + ctx.skipped + ctx.errors;
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
            if (total > 0) {
              reporter.progress(0, total, counts());
            }

            for (const row of ctx.unmatched) {
              task.title = `${baseTitle} — ${formatTitle(row.title)}`;
              const resolved = providerIdFor(row);
              if (!resolved) {
                ctx.skipped += 1;
                task.title = `${baseTitle} — ${formatTitle(row.title, " — skipped")}`;
                reporter.progress(done(), total, counts());
                continue;
              }

              let result: MangaDexMatchResultBody;
              try {
                const titles = await loadRegistrySearchTitles(row, { anilistToken: anilist });
                const [primary, ...aliases] = titles;
                result = await apiCall(
                  config,
                  "/v1/canonical/mangadex/resolve",
                  "POST",
                  {
                    id: row.id,
                    provider: resolved.provider,
                    providerId: resolved.providerId,
                    title: primary ?? row.title,
                    aliases,
                    externalIds: Object.fromEntries(
                      row.providers
                        .filter(
                          (p) =>
                            p.provider === "anilist" ||
                            p.provider === "mal" ||
                            p.provider === "mangadex",
                        )
                        .map((p) => [p.provider, p.externalId]),
                    ),
                    persistSearchResults: apply,
                  },
                  MangaDexMatchResult,
                );
              } catch {
                ctx.errors += 1;
                task.title = `${baseTitle} — ${formatTitle(row.title, " — error")}`;
                reporter.progress(done(), total, counts());
                await sleep(delayMs);
                continue;
              }

              if (result.status === "matched" && result.externalId) {
                ctx.linked += 1;
                if (apply) {
                  await apiCall(
                    config,
                    `/v1/entries/${encodeURIComponent(row.id)}/providers`,
                    "POST",
                    { provider: "mangadex", externalId: result.externalId, title: row.title },
                    RegistryEntry,
                  );
                }
                const method = result.method ? ` ${result.method}` : "";
                const score = result.score !== undefined ? ` ${result.score.toFixed(3)}` : "";
                task.title = `${baseTitle} — ${formatTitle(row.title, ` → ${result.externalId.slice(0, 8)}…${method}${score}`)}`;
              } else if (result.status === "ambiguous") {
                ctx.ambiguous += 1;
                task.title = `${baseTitle} — ${formatTitle(row.title, " — ambiguous")}`;
              } else {
                ctx.notFound += 1;
                task.title = `${baseTitle} — ${formatTitle(row.title, " — not_found")}`;
              }
              reporter.progress(done(), total, counts());
              await sleep(delayMs);
            }
            task.title = baseTitle;
            reporter.note(
              `❖ ${apply ? "Applied" : "Dry run"}: ${ctx.linked} linked · ${ctx.ambiguous} ambiguous · ${ctx.notFound} not_found · ${ctx.skipped} skipped · ${ctx.errors} errors. ${apply ? "" : "Re-run with --apply to write."}`,
            );
          },
          rendererOptions: { outputBar: 1, persistentOutput: true },
        };

        const run = createRun<MangadexCtx>([loadTask, sweepTask]);
        const ctx: MangadexCtx = {
          unmatched: [],
          linked: 0,
          ambiguous: 0,
          notFound: 0,
          skipped: 0,
          errors: 0,
        };
        try {
          await run.run(ctx);
          const summary =
            `${ctx.linked} linked · ${ctx.ambiguous} ambiguous · ${ctx.notFound} not_found` +
            (ctx.skipped ? ` · ${ctx.skipped} skipped` : "") +
            (ctx.errors ? ` · ${ctx.errors} errors` : "");
          if (ctx.errors > 0) {
            frameDetail(`errors: ${ctx.errors} — re-run with --limit to retry`);
          }
          closeFrame(
            apply
              ? `MangaDex prefill applied — ${summary}`
              : `MangaDex prefill dry run — ${summary}`,
          );
        } catch (error) {
          abortFrame();
          throw error;
        }
        process.exit(0);
      },
      catch: (cause) => new Error(errorMessage(cause)),
    }),
  ),
);
