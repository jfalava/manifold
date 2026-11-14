/** @effect-diagnostics asyncFunction:off */
import { createInterface } from "node:readline/promises";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type { ListrTask } from "listr2";
import { RegistryEntry } from "@manifold/contract";
import { errorMessage } from "@manifold/json";
import { apiCall, apiConfig, listRegistryRows, type RegistryRow } from "@/commands/toolbox";
import { loadRegistrySearchTitles, searchTitlesFor } from "@/registry-titles";
import { coverageComparisons, coverageDifference } from "@/chapter-coverage";
import { classifyPage, openBunBrowserView, type BrowserView } from "@/browser-view";
import { resolveValue } from "@/env-resolve";
import {
  cliError,
  sleepPromise,
  validateNonNegativeLimit,
  validateDelayMs,
  validateMaxPages,
} from "@/effect-kit";
import {
  createKaganeClient,
  hasExactKaganeTitle,
  KAGANE_ORIGIN,
  KaganeChallengeError,
  KaganeCooldownError,
  kaganeProfileDir,
  kaganeSearchQuery,
  selectKaganeCandidate,
  verifyKaganeCandidate,
  type KaganeBook,
  type KaganeCandidate,
} from "@/kagane";
import { resolveAniListToken } from "@/login/anilist";
import { openRegistryReport } from "@/registry-report";
import { RegistryPageBudgetError } from "@/registry-catalog";
import { matchesStatusFilter, parseStatusFilter, STATUS_FILTER_HINT } from "@/registry-status";
import { terminalSession } from "@/terminal-alert";
import {
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";

interface KaganeCtx extends RunContext {
  rows: readonly RegistryRow[];
  selected: readonly RegistryRow[];
}

const KAGANE_RESUME_POLICY = {
  searchPolicy: "kagane-bounded-aliases-v2",
  selectionPolicy: "kagane-no-loss-publisher-labels-v4",
};

export const kaganePrefillCommand = Command.make("kagane", {
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
  auditExisting: Flag.Boolean("audit-existing").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Read-only coverage audit including existing links; cannot combine with --apply.",
    ),
  ),
  limit: Flag.Int("limit").pipe(Flag.optional),
  status: Flag.String("status").pipe(
    Flag.withDefault("auto"),
    Flag.withDescription(STATUS_FILTER_HINT),
  ),
  language: Flag.String("language").pipe(
    Flag.withDefault("en"),
    Flag.withDescription("Kagane content language (default en)."),
  ),
  delay: Flag.Int("delay").pipe(
    Flag.withDefault(1_500),
    Flag.withDescription("Milliseconds between Kagane requests."),
  ),
  maxPages: Flag.Int("max-pages").pipe(
    Flag.withDefault(200),
    Flag.withDescription("Maximum pages per search (default 200); incomplete searches never link."),
  ),
  sourcePriority: Flag.String("source-priority").pipe(
    Flag.withDefault("Kodansha Comics,VIZ Media,Manga Up!,Comikey,Crunchyroll,Square Enix Manga"),
    Flag.withDescription(
      "Tie-break equal chapter coverage by source name; none disables preference. MangaDex is excluded.",
    ),
  ),
  report: Flag.String("report").pipe(
    Flag.optional,
    Flag.withDescription("New JSONL report path; default ~/.manifold/reports/kagane-<run>.jsonl."),
  ),
  resume: Flag.String("resume").pipe(
    Flag.optional,
    Flag.withDescription("Resume a previous JSONL report; retry errors and challenges."),
  ),
  chromeCdpUrl: Flag.String("chrome-cdp-url").pipe(
    Flag.optional,
    Flag.withDescription(
      "Use a local Chrome debug session for Cloudflare; MANIFOLD_KAGANE_CHROME_CDP_URL.",
    ),
  ),
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
  anilistToken: Flag.String("anilist-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Backfill Kagane links using external IDs and exact titles. Dry-run by default; never replaces links.",
  ),
  Command.withHandler(
    ({
      apply,
      auditExisting,
      limit,
      status,
      language,
      delay,
      maxPages,
      sourcePriority,
      report,
      resume,
      chromeCdpUrl,
      apiOrigin,
      apiToken,
      anilistToken,
    }) =>
      Effect.tryPromise({
        try: async () => {
          if (apply && auditExisting) {
            throw cliError("--audit-existing is read-only; do not combine with --apply.");
          }

          const maximum = Option.getOrUndefined(limit);
          validateNonNegativeLimit(maximum);

          validateDelayMs(delay);

          validateMaxPages(maxPages);

          const priority =
            sourcePriority.toLowerCase() === "none"
              ? []
              : sourcePriority
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean);

          if (priority.length === 0 && sourcePriority.toLowerCase() !== "none") {
            throw cliError("--source-priority requires source names or none.");
          }

          if (priority.some((name) => name.toLowerCase() === "mangadex")) {
            throw cliError(
              "MangaDex is excluded as a Kagane content source; use the native MangaDex provider.",
            );
          }

          if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language)) {
            throw cliError("--language must be a language code such as en or pt-BR.");
          }

          const config = await apiConfig(apiOrigin, apiToken);
          const statuses = parseStatusFilter(status);
          const anilist = await resolveAniListToken(Option.getOrUndefined(anilistToken));
          const chromeUrl = resolveValue(chromeCdpUrl, "MANIFOLD_KAGANE_CHROME_CDP_URL");

          const counts = {
            matched: 0,
            ambiguous: 0,
            unmatched: 0,
            conflicts: 0,
            errors: 0,
            challenged: 0,
            deferred: 0,
          };

          const retryWhen = { ...KAGANE_RESUME_POLICY, maxPages };
          let view: BrowserView | undefined;

          const journal = openRegistryReport(
            "kagane",
            apply,
            {
              apiOrigin: config.origin,
              language,
              auditExisting,
              sourcePriority: priority,
              excludedSources: ["MangaDex"],
              anilistAliases: Boolean(anilist),
            },
            Option.getOrUndefined(report),
            Option.getOrUndefined(resume),
          );

          const reportPath = journal.path;
          const record = journal.record;
          openFrame(`Kagane registry prefill → ${apply ? "apply" : "dry run"}`);
          frameDetail(`Report: ${reportPath}`);

          const load: ListrTask<KaganeCtx> = {
            title: "Load registry rows",
            task: async (ctx, task) => {
              ctx.rows = await listRegistryRows(config);

              const eligible = ctx.rows.filter(
                (row) =>
                  !row.tombstoned &&
                  (auditExisting || !row.providers.some((link) => link.provider === "kagane")) &&
                  matchesStatusFilter(row.state?.status, statuses) &&
                  !journal.skip(row, retryWhen),
              );

              ctx.selected = maximum === undefined ? eligible : eligible.slice(0, maximum);
              makePhaseReporter(task).note(
                `${eligible.length} eligible; ${ctx.selected.length} to check`,
              );
            },
          };

          const sweep: ListrTask<KaganeCtx> = {
            title: "Search Kagane and verify candidates",
            task: async (ctx, task) => {
              if (ctx.selected.length === 0) {
                return;
              }

              const reporter = makePhaseReporter(task);
              let context = "Kagane catalog";

              const progress = (message: string): void => {
                const detail = `${context}: ${message}`;
                record({ event: "progress", message: detail });
                reporter.detail(message);
              };

              const onBlocked = async (error: KaganeChallengeError): Promise<void> => {
                if (!process.stdin.isTTY || !view) {
                  throw error;
                }

                terminalSession()?.blocked("auth", "Solve Kagane challenge in Chrome");
                progress("PAUSED · solve challenge in Chrome · Enter retries · Ctrl-C cancels");

                const reader = createInterface({
                  input: process.stdin,
                  terminal: false,
                  signal: task.signal,
                });

                try {
                  for await (const _line of reader) {
                    if (task.signal.aborted) {
                      throw error;
                    }

                    progress("Retrying the paused Kagane request");

                    return;
                  }

                  throw error;
                } finally {
                  reader.close();
                  process.stdin.pause();
                  terminalSession()?.resume();
                }
              };

              if (chromeUrl) {
                progress("Connecting to Chrome");
                view = openBunBrowserView({ chromeUrl, profileDir: kaganeProfileDir() });
                await view.navigate(`${KAGANE_ORIGIN}/`);
                let ready = false;

                // Navigation can resolve before the new document is committed.
                for (let attempt = 0; attempt < 30; attempt++) {
                  const current = await view.evaluate<string>(
                    "location.origin + '|' + document.readyState + '|' + document.title",
                  );

                  if (current.startsWith(`${KAGANE_ORIGIN}|complete|`)) {
                    if (classifyPage(current, "") === "challenge") {
                      await onBlocked(new KaganeChallengeError());
                      attempt = -1;
                      continue;
                    }

                    ready = true;
                    break;
                  }

                  await sleepPromise(500);
                }

                if (!ready) {
                  throw cliError(
                    "Kagane Chrome tab did not finish loading; solve its challenge and rerun.",
                  );
                }
              }

              const client = createKaganeClient({
                delay,
                view,
                maxPages,
                onProgress: progress,
                catalog: journal.catalog,
                onCache: record,
                onBlocked,
                onRetry: (message) => {
                  record({ event: "retry", message });
                  reporter.detail(message);
                },
              });

              const sources = new Map(
                (await client.sources()).sources.map((source) => [source.source_id, source.title]),
              );

              const allowedSources = sources
                .entries()
                .filter(([, title]) => title.trim().toLowerCase() !== "mangadex")
                .map(([id]) => id)
                .toArray();

              if (allowedSources.length === 0) {
                throw cliError("No non-MangaDex Kagane sources are available.");
              }

              for (const name of priority) {
                const ids = sources
                  .entries()
                  .filter(([, title]) => title.toLowerCase() === name.toLowerCase())
                  .map(([id]) => id)
                  .toArray();

                if (ids.length === 0) {
                  throw cliError(
                    `Unknown Kagane source "${name}"; use a name from sources/list or --source-priority none.`,
                  );
                }
              }

              const owners = new Map(
                ctx.rows.flatMap((row) =>
                  row.providers
                    .filter((link) => link.provider === "kagane")
                    .map((link) => [link.externalId, row.id] as const),
                ),
              );

              for (const [index, row] of ctx.selected.entries()) {
                const checked = new Map<string, KaganeCandidate>();
                const knownIds = new Set(journal.candidateIds(row));

                const discovered = new Set<string>();
                const exactMatches = new Set<string>();
                const exclusions: { id: string; title: string; source: string }[] = [];

                const discovery = {
                  complete: false,
                  results: 0,
                  exact: 0,
                  excludedMangaDex: 0,
                  unknownSource: 0,
                  exclusions,
                };

                let titles: readonly string[] = [];
                const queries: { title: string; query: string }[] = [];
                let basis = "candidate discovery or inventory verification did not complete";

                const retain = (id: string): void => {
                  if (knownIds.has(id)) {
                    return;
                  }

                  knownIds.add(id);
                  record({
                    event: "catalog",
                    kind: "candidates",
                    key: row.id,
                    data: [...knownIds],
                  });
                };

                let selected: KaganeCandidate | undefined;

                let outcome:
                  | "matched"
                  | "ambiguous"
                  | "unmatched"
                  | "conflicts"
                  | "errors"
                  | "deferred" = "unmatched";

                let note = "";
                let retryable = false;

                try {
                  const entryContext = `${index + 1}/${ctx.selected.length} ${row.title}`;
                  context = entryContext;
                  reporter.item(context);
                  progress("Loading search titles");

                  titles = await loadRegistrySearchTitles(row, {
                    anilistToken: anilist,
                    onProgress: progress,
                    onIncomplete: () => {
                      retryable = true;
                    },
                  });

                  // Discover globally before ranking: a preferred source may be incomplete.
                  context = `${entryContext} [all non-MangaDex sources]`;
                  const candidates = new Map<string, KaganeBook>();

                  const sent = new Set<string>();

                  for (const title of searchTitlesFor(titles)) {
                    const query = kaganeSearchQuery(title);
                    queries.push({ title, query });
                    record({ event: "query", key: row.id, title, query });

                    if (sent.has(query)) {
                      continue;
                    }

                    sent.add(query);

                    if (query !== title) {
                      reporter.note(
                        `SEARCH ${row.id}: shortened discovery query to 200 UTF-8 bytes or fewer; full title still required`,
                      );
                    }

                    await client.search(query, language, [], (book) => {
                      // Kagane caps source_id values; filter the full-catalog fallback locally.
                      const exact = hasExactKaganeTitle(titles, [
                        book.title,
                        ...(book.alternate_titles ?? []),
                      ]);

                      const allowed = allowedSources.includes(book.source_id ?? "");

                      if (!discovered.has(book.series_id)) {
                        discovered.add(book.series_id);
                        discovery.results++;
                      }

                      if (exact && !exactMatches.has(book.series_id)) {
                        exactMatches.add(book.series_id);
                        discovery.exact++;

                        if (!allowed) {
                          const source = sources.get(book.source_id ?? "") ?? "unknown";

                          if (source.trim().toLowerCase() === "mangadex") {
                            discovery.excludedMangaDex++;
                          } else {
                            discovery.unknownSource++;
                          }

                          if (discovery.exclusions.length < 10) {
                            discovery.exclusions.push({
                              id: book.series_id,
                              title: book.title,
                              source,
                            });
                          }
                        }
                      }

                      if (allowed && exact) {
                        candidates.set(book.series_id, book);
                        retain(book.series_id);
                      }
                    });
                  }

                  discovery.complete = true;

                  const currentId = row.providers.find(
                    (link) => link.provider === "kagane",
                  )?.externalId;

                  if (currentId) {
                    retain(currentId);
                  }

                  for (const id of knownIds) {
                    if (candidates.has(id)) {
                      continue;
                    }

                    const details = await client.details(id);
                    candidates.set(id, {
                      series_id: id,
                      title: details.title,
                      source_id: details.source_id,
                    });
                  }

                  for (const book of candidates.values()) {
                    if (!checked.has(book.series_id)) {
                      const details = await client.details(book.series_id);

                      const candidate = verifyKaganeCandidate(
                        book,
                        details,
                        row,
                        titles,
                        language,
                        sources.get(book.source_id ?? ""),
                      );

                      const reasons = [...candidate.reasons];

                      if (!allowedSources.includes(details.source_id ?? "")) {
                        reasons.push("excluded or unknown source");
                      }

                      checked.set(book.series_id, {
                        ...candidate,
                        reasons,
                        ...(reasons.length === 0 && {
                          coverage: await client.coverage(book.series_id),
                        }),
                      });
                    }
                  }

                  const decision = selectKaganeCandidate([...checked.values()], priority);
                  selected = decision.selected;
                  basis =
                    checked.size > 0
                      ? decision.basis
                      : discovery.exact > 0
                        ? `${discovery.excludedMangaDex} exact matches excluded as MangaDex; ${discovery.unknownSource} with unknown source`
                        : discovery.results > 0
                          ? "search returned results, but no exact full-title or alias match"
                          : "search returned no results";

                  const selection = {
                    selectedId: selected?.id ?? null,
                    basis,
                    comparisons: coverageComparisons([...checked.values()]),
                  };

                  record({
                    event: "selection",
                    key: row.id,
                    ...selection,
                    candidates: [...checked.values()],
                  });

                  if (checked.size) {
                    reporter.note(
                      `${selected ? "SELECTION" : "REVIEW"} ${row.id}: ${selected?.id ?? "no safe coverage winner"}; ${basis}`,
                    );

                    for (const candidate of checked.values()) {
                      reporter.note(
                        `  ${candidate.id} [${candidate.source}; ${candidate.coverage?.count ?? "?"} ${candidate.coverage?.unit ?? "unknown"}; IDs=${candidate.matchedIds.join("+") || "title-only"}; ${candidate.reasons.join(", ") || "eligible"}]`,
                      );
                    }
                  }

                  if (checked.size === 0) {
                    note = `UNMATCHED ${row.id} ${row.title}: ${basis}`;
                  } else if (!selected) {
                    outcome = "ambiguous";
                    note = `${checked.size === 1 ? "UNVERIFIED" : "AMBIGUOUS"} ${row.id} ${row.title}: ${basis}`;
                  } else if (owners.has(selected.id) && owners.get(selected.id) !== row.id) {
                    outcome = "conflicts";
                    note = `CONFLICT ${row.id}: kagane:${selected.id} already belongs to ${owners.get(selected.id)}`;
                  } else {
                    if (apply) {
                      progress("Saving verified provider link");
                      await apiCall(
                        config,
                        `/v1/entries/${encodeURIComponent(row.id)}/providers`,
                        "POST",
                        {
                          provider: "kagane",
                          externalId: selected.id,
                          title: selected.title,
                          sourceName: selected.source,
                          onConflict: "reject",
                        },
                        RegistryEntry,
                      );
                    }

                    owners.set(selected.id, row.id);
                    outcome = "matched";
                    note = `${apply ? "LINKED" : currentId ? "PROPOSED (existing link unchanged)" : "WOULD LINK"} ${row.id} → kagane:${selected.id} [${selected.source}; ${selected.coverage?.count} ${selected.coverage?.unit}] IDs=${selected.matchedIds.join("+") || "title-only"}`;
                  }
                } catch (error) {
                  const challenged =
                    error instanceof KaganeChallengeError ||
                    /Kagane Cloudflare challenge/.test(errorMessage(error));

                  if (challenged || error instanceof KaganeCooldownError) {
                    if (!challenged) {
                      counts.errors++;
                    }

                    record({
                      event: "entry",
                      entryId: row.id,
                      title: row.title,
                      outcome: challenged ? "challenged" : "errors",
                      error: errorMessage(error),
                      candidateIds: [...knownIds],
                      candidates: [...checked.values()],
                      titles: [...titles],
                      queries,
                      discovery,
                    });
                    throw error;
                  }

                  if (error instanceof RegistryPageBudgetError) {
                    outcome = "deferred";
                    note = `DEFERRED ${row.id}: ${error.message}; increase --max-pages to retry`;
                  } else if (/Provider link conflict:/.test(errorMessage(error))) {
                    outcome = "conflicts";
                    note = `CONFLICT ${row.id}: ${errorMessage(error)}`;
                  } else {
                    outcome = "errors";
                    note = `ERROR ${row.id} ${row.title}: ${errorMessage(error)}`;
                  }
                }

                counts[outcome]++;
                journal.entry(row, {
                  event: "entry",
                  entryId: row.id,
                  title: row.title,
                  outcome,
                  retryable,
                  ...KAGANE_RESUME_POLICY,
                  retryWhen,
                  deferredReason: outcome === "deferred" ? "page_budget" : null,
                  candidateIds: [...knownIds],
                  titles: [...titles],
                  queries,
                  discovery,
                  selection: {
                    selectedId: selected?.id ?? null,
                    basis,
                    comparisons: coverageComparisons([...checked.values()]),
                  },
                  selectedId: selected?.id ?? null,
                  currentId:
                    row.providers.find((link) => link.provider === "kagane")?.externalId ?? null,
                  coverageDifference: coverageDifference(
                    checked.get(
                      row.providers.find((link) => link.provider === "kagane")?.externalId ?? "",
                    )?.coverage,
                    selected?.coverage,
                  ),
                  note,
                  candidates: [...checked.values()],
                });
                reporter.note(note);
                reporter.progress(index + 1, ctx.selected.length, Object.entries(counts));
              }
            },
          };

          let failure: string | undefined;

          try {
            record({
              event: "options",
              apply,
              auditExisting,
              status,
              language,
              delay,
              maxPages,
              sourcePriority: priority,
              excludedSources: ["MangaDex"],
            });
            await createRun<KaganeCtx>([load, sweep]).run({ rows: [], selected: [] });
          } catch (error) {
            failure = errorMessage(error);

            if (/Kagane Cloudflare challenge/.test(errorMessage(error))) {
              counts.challenged++;
            }

            throw error;
          } finally {
            try {
              record({
                event: "summary",
                completed: failure === undefined,
                counts,
                ...(failure !== undefined && { error: failure }),
              });
            } finally {
              journal.close();
              view?.close();

              const label = failure
                ? "Stopped"
                : counts.errors + counts.conflicts > 0
                  ? "Completed with errors"
                  : apply
                    ? "Applied"
                    : "Dry run";

              closeFrame(
                `${label}: ${Object.entries(counts)
                  .map(([name, count]) => `${count} ${name}`)
                  .join(
                    "; ",
                  )}\nReport: ${reportPath}${apply && (failure || counts.errors + counts.conflicts > 0) ? "\nSuccessful links remain saved." : ""}`,
                failure !== undefined || counts.errors + counts.conflicts > 0,
              );
            }
          }

          if (counts.errors + counts.conflicts > 0) {
            throw cliError(`Kagane prefill completed with errors/conflicts; inspect ${reportPath}`);
          }
        },
        catch: (cause) => cliError(errorMessage(cause)),
      }),
  ),
);
