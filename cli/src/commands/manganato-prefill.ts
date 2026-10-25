/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type { ListrTask } from "listr2";
import { RegistryEntry } from "@manifold/contract";
import { errorMessage, type JsonValue } from "@manifold/json";
import { apiCall, apiConfig, listRegistryRows, type RegistryRow } from "@/commands/toolbox";
import { classifyPage, openBunBrowserView, type BrowserView } from "@/browser-view";
import { resolveValue } from "@/env-resolve";
import {
  cliError,
  epochMillisNow,
  jsonBodyString,
  newId,
  sleepPromise,
  validateNonNegativeLimit,
} from "@/effect-kit";
import {
  createManganatoClient,
  hasManganatoAuthor,
  hasManganatoTitle,
  loadManganatoIdentity,
  MANGANATO_ORIGIN,
  ManganatoBlockedError,
  manganatoSearchTerms,
  selectManganatoCandidate,
  type ManganatoDetails,
} from "@/manganato";
import { withProgramStatus } from "@/program-status";
import { matchesStatusFilter, parseStatusFilter, STATUS_FILTER_HINT } from "@/registry-status";
import {
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";

interface ManganatoCtx extends RunContext {
  rows: readonly RegistryRow[];
  selected: readonly RegistryRow[];
}

export const manganatoPrefillCommand = Command.make("manganato", {
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
  limit: Flag.Int("limit").pipe(Flag.optional),
  status: Flag.String("status").pipe(
    Flag.withDefault("auto"),
    Flag.withDescription(STATUS_FILTER_HINT),
  ),
  delay: Flag.Int("delay").pipe(
    Flag.withDefault(4_000),
    Flag.withDescription("Milliseconds between MangaNato requests (default 4000)."),
  ),
  maxPages: Flag.Int("max-pages").pipe(
    Flag.withDefault(20),
    Flag.withDescription("Maximum pages per search; incomplete searches never link."),
  ),
  report: Flag.String("report").pipe(
    Flag.optional,
    Flag.withDescription(
      "New JSONL report path; default ~/.manifold/reports/manganato-<run>.jsonl.",
    ),
  ),
  chromeCdpUrl: Flag.String("chrome-cdp-url").pipe(
    Flag.optional,
    Flag.withDescription(
      "Regular Chrome browser WebSocket URL; MANIFOLD_MANGANATO_CHROME_CDP_URL.",
    ),
  ),
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Backfill MangaNato links through Chrome using exact titles and author evidence. Dry-run by default; never replaces links.",
  ),
  Command.withHandler(
    ({ apply, limit, status, delay, maxPages, report, chromeCdpUrl, apiOrigin, apiToken }) =>
      withProgramStatus((programStatus) =>
        Effect.tryPromise({
          try: async () => {
            programStatus.phase("Preparing MangaNato registry");
            const maximum = Option.getOrUndefined(limit);
            validateNonNegativeLimit(maximum);
            if (!Number.isSafeInteger(delay) || delay < 0) {
              throw cliError("--delay must be a non-negative integer (milliseconds).");
            }
            if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
              throw cliError("--max-pages must be a positive integer.");
            }
            const chromeUrl = resolveValue(chromeCdpUrl, "MANIFOLD_MANGANATO_CHROME_CDP_URL");
            if (!chromeUrl) {
              throw cliError(
                "MangaNato requires regular Chrome. Pass --chrome-cdp-url <ws://...> after opening www.manganato.gg and solving any challenge.",
              );
            }
            const config = await apiConfig(apiOrigin, apiToken);
            const statuses = parseStatusFilter(status);
            const counts = {
              matched: 0,
              ambiguous: 0,
              unmatched: 0,
              conflicts: 0,
              errors: 0,
              challenged: 0,
            };
            const reportPath = resolve(
              Option.getOrUndefined(report) ??
                join(
                  homedir(),
                  ".manifold",
                  "reports",
                  `manganato-${epochMillisNow()}-${newId()}.jsonl`,
                ),
            );
            mkdirSync(dirname(reportPath), { recursive: true });
            const file = openSync(reportPath, "wx", 0o600);
            const record = (line: JsonValue): void => {
              writeSync(file, `${jsonBodyString(line)}\n`);
            };
            let view: BrowserView | undefined;
            openFrame(`MangaNato registry prefill → ${apply ? "apply" : "dry run"}`);
            frameDetail(`Report: ${reportPath}`);
            const load: ListrTask<ManganatoCtx> = {
              title: "Load registry rows",
              task: async (ctx, task) => {
                programStatus.phase("Loading registry");
                ctx.rows = await listRegistryRows(config);
                const eligible = ctx.rows.filter(
                  (row) =>
                    !row.tombstoned &&
                    !row.providers.some((link) => link.provider === "manganato") &&
                    matchesStatusFilter(row.state?.status, statuses),
                );
                ctx.selected = maximum === undefined ? eligible : eligible.slice(0, maximum);
                makePhaseReporter(task).note(
                  `${eligible.length} eligible; ${ctx.selected.length} to check`,
                );
              },
            };
            const sweep: ListrTask<ManganatoCtx> = {
              title: "Search MangaNato and verify titles/authors",
              task: async (ctx, task) => {
                if (!ctx.selected.length) {
                  return;
                }
                const reporter = makePhaseReporter(task);
                let context = "MangaNato catalog";
                const progress = (message: string): void => {
                  record({ event: "progress", message: `${context}: ${message}` });
                  reporter.detail(`${context}: ${message}`);
                };
                programStatus.phase("Connecting to Chrome");
                progress("Connecting to regular Chrome");
                view = openBunBrowserView({
                  chromeUrl,
                  profileDir: join(homedir(), ".manifold", "manganato-chrome"),
                });
                await view.navigate(`${MANGANATO_ORIGIN}/`);
                let ready = false;
                for (let attempt = 0; attempt < 30; attempt++) {
                  const current = await view.evaluate<string>(
                    "location.origin + '|' + document.readyState + '|' + document.title",
                  );
                  if (current.startsWith(`${MANGANATO_ORIGIN}|complete|`)) {
                    if (classifyPage(current, "") === "challenge") {
                      throw new ManganatoBlockedError({
                        message:
                          "MangaNato Cloudflare challenge; solve it in regular Chrome and rerun.",
                      });
                    }
                    ready = true;
                    break;
                  }
                  await sleepPromise(500);
                }
                if (!ready) {
                  throw cliError(
                    "MangaNato Chrome tab did not finish loading; check Chrome and rerun.",
                  );
                }
                const client = createManganatoClient({
                  view,
                  delay,
                  maxPages,
                  onProgress: progress,
                });
                // Include every row, including tombstones, when checking external-ID ownership.
                const owners = new Map(
                  ctx.rows.flatMap((row) =>
                    row.providers
                      .filter((link) => link.provider === "manganato")
                      .map((link) => [link.externalId, row.id] as const),
                  ),
                );
                programStatus.phase(
                  apply ? "Checking and linking MangaNato" : "Checking MangaNato links",
                );
                programStatus.progress(0, ctx.selected.length);
                for (const [index, row] of ctx.selected.entries()) {
                  context = `${index + 1}/${ctx.selected.length} ${row.title}`;
                  let outcome: keyof typeof counts = "unmatched";
                  let note = "No exact title/alias candidates";
                  let selected: ManganatoDetails | undefined;
                  const candidates = new Map<string, ManganatoDetails>();
                  let titles: readonly string[] = [row.title];
                  let authors: readonly string[] = [];
                  let queries: readonly string[] = [];
                  let blocked: ManganatoBlockedError | undefined;
                  try {
                    const identity = await loadManganatoIdentity(row, progress);
                    titles = identity.titles;
                    authors = identity.authors;
                    queries = manganatoSearchTerms(titles);
                    for (const query of queries) {
                      for (const hit of await client.search(query)) {
                        if (!candidates.has(hit.id) && hasManganatoTitle(titles, [hit.title])) {
                          candidates.set(hit.id, await client.details(hit.id));
                        }
                      }
                    }
                    selected =
                      candidates.size === 1
                        ? selectManganatoCandidate(identity, [...candidates.values()])
                        : undefined;
                    if (selected) {
                      if (owners.has(selected.id) && owners.get(selected.id) !== row.id) {
                        outcome = "conflicts";
                        note = `manganato:${selected.id} already belongs to ${owners.get(selected.id)}`;
                      } else {
                        if (apply) {
                          progress(`Saving manganato:${selected.id}`);
                          await apiCall(
                            config,
                            `/v1/entries/${encodeURIComponent(row.id)}/providers`,
                            "POST",
                            {
                              provider: "manganato",
                              externalId: selected.id,
                              title: selected.title,
                              onConflict: "reject",
                            },
                            RegistryEntry,
                          );
                        }
                        owners.set(selected.id, row.id);
                        outcome = "matched";
                        note = `${apply ? "LINKED" : "WOULD LINK"} manganato:${selected.id}; exact title + author/artist`;
                      }
                    } else if (candidates.size) {
                      outcome = "ambiguous";
                      note =
                        candidates.size > 1
                          ? "Duplicate title candidates; no chapter-count tie-break"
                          : "Author evidence missing or mismatched";
                    }
                  } catch (error) {
                    outcome =
                      error instanceof ManganatoBlockedError
                        ? "challenged"
                        : /Provider link conflict:/.test(errorMessage(error))
                          ? "conflicts"
                          : "errors";
                    if (error instanceof ManganatoBlockedError) {
                      blocked = error;
                    }
                    note = errorMessage(error);
                  }
                  counts[outcome]++;
                  record({
                    event: "entry",
                    entryId: row.id,
                    title: row.title,
                    outcome,
                    note,
                    titles: [...titles],
                    authors: [...authors],
                    queries: [...queries],
                    selectedId: selected?.id ?? null,
                    candidates: [...candidates.values()].map((candidate) => ({
                      ...candidate,
                      exactTitle: hasManganatoTitle(titles, [
                        candidate.title,
                        ...candidate.aliases,
                      ]),
                      authorMatch: hasManganatoAuthor(authors, candidate.authors),
                    })),
                  });
                  reporter.note(`${outcome.toUpperCase()} ${row.title}: ${note}`);
                  reporter.progress(index + 1, ctx.selected.length, Object.entries(counts));
                  programStatus.progress(index + 1, ctx.selected.length);
                  if (blocked) {
                    throw blocked;
                  }
                }
              },
            };
            let failure: string | undefined;
            try {
              record({
                event: "run",
                apply,
                status,
                delay,
                maxPages,
                language: "en",
                identity: "exact title + author/artist; duplicate slugs stay ambiguous",
              });
              await createRun<ManganatoCtx>([load, sweep]).run({ rows: [], selected: [] });
            } catch (error) {
              failure = errorMessage(error);
              if (error instanceof ManganatoBlockedError && counts.challenged === 0) {
                counts.challenged++;
              }
              throw error;
            } finally {
              programStatus.phase("Finalizing report");
              programStatus.summary(
                `${apply ? "Apply" : "Dry run"}: ${Object.entries(counts)
                  .map(([name, count]) => `${count} ${name}`)
                  .join("; ")}`,
                counts.errors + counts.conflicts + counts.challenged > 0,
              );
              try {
                record({
                  event: "summary",
                  completed: failure === undefined,
                  counts,
                  ...(failure && { error: failure }),
                });
              } finally {
                closeSync(file);
                view?.close();
                closeFrame(
                  `${failure ? "Stopped" : counts.errors + counts.conflicts ? "Completed with errors" : apply ? "Applied" : "Dry run"}: ${Object.entries(
                    counts,
                  )
                    .map(([name, count]) => `${count} ${name}`)
                    .join(
                      "; ",
                    )}\nReport: ${reportPath}${apply && (failure || counts.errors + counts.conflicts) ? "\nSuccessful links remain saved." : ""}`,
                );
              }
            }
            if (counts.errors + counts.conflicts) {
              throw cliError(`MangaNato prefill has errors/conflicts; inspect ${reportPath}`);
            }
          },
          catch: (cause) => cliError(errorMessage(cause)),
        }),
      ),
  ),
);
