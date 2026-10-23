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
import { loadRegistrySearchTitles, searchTitlesFor } from "@/registry-titles";
import { coverageDifference } from "@/chapter-coverage";
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
  createKaganeClient,
  hasExactKaganeTitle,
  KAGANE_ORIGIN,
  KaganeChallengeError,
  KaganeCooldownError,
  kaganeProfileDir,
  selectKaganeCandidate,
  verifyKaganeCandidate,
  type KaganeBook,
  type KaganeCandidate,
} from "@/kagane";
import { resolveAniListToken } from "@/login/anilist";
import { matchesStatusFilter, parseStatusFilter, STATUS_FILTER_HINT } from "@/registry-status";
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
          if (!Number.isSafeInteger(delay) || delay < 0) {
            throw cliError("--delay must be a non-negative integer (milliseconds).");
          }
          if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
            throw cliError("--max-pages must be a positive integer.");
          }
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
          };
          let view: BrowserView | undefined;
          const reportPath = resolve(
            Option.getOrUndefined(report) ??
              join(
                homedir(),
                ".manifold",
                "reports",
                `kagane-${epochMillisNow()}-${newId()}.jsonl`,
              ),
          );
          mkdirSync(dirname(reportPath), { recursive: true });
          // Refuse to truncate an earlier report. Persist each row before processing the next.
          const reportFile = openSync(reportPath, "wx", 0o600);
          const record = (line: JsonValue): void => {
            writeSync(reportFile, `${jsonBodyString(line)}\n`);
          };
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
                  matchesStatusFilter(row.state?.status, statuses),
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
                reporter.detail(detail);
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
                      throw new KaganeChallengeError();
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
                onRetry: (message) => {
                  record({ event: "retry", message });
                  reporter.detail(message);
                },
              });
              const sources = new Map(
                (await client.sources()).sources.map((source) => [source.source_id, source.title]),
              );
              const allowedSources = [...sources]
                .filter(([, title]) => title.trim().toLowerCase() !== "mangadex")
                .map(([id]) => id);
              if (allowedSources.length === 0) {
                throw cliError("No non-MangaDex Kagane sources are available.");
              }
              for (const name of priority) {
                const ids = [...sources]
                  .filter(([, title]) => title.toLowerCase() === name.toLowerCase())
                  .map(([id]) => id);
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
                let selected: KaganeCandidate | undefined;
                let outcome: "matched" | "ambiguous" | "unmatched" | "conflicts" | "errors" =
                  "unmatched";
                let note = "";
                try {
                  const entryContext = `${index + 1}/${ctx.selected.length} ${row.title}`;
                  context = entryContext;
                  progress("Loading search titles");
                  const titles = await loadRegistrySearchTitles(row, {
                    anilistToken: anilist,
                    onProgress: progress,
                  });
                  // Discover globally before ranking: a preferred source may be incomplete.
                  context = `${entryContext} [all non-MangaDex sources]`;
                  const candidates = new Map<string, KaganeBook>();
                  for (const title of searchTitlesFor(titles)) {
                    for (const book of await client.search(title, language)) {
                      // Kagane caps source_id values; filter the full-catalog fallback locally.
                      if (
                        allowedSources.includes(book.source_id ?? "") &&
                        hasExactKaganeTitle(titles, [book.title, ...(book.alternate_titles ?? [])])
                      ) {
                        candidates.set(book.series_id, book);
                      }
                    }
                  }
                  const currentId = row.providers.find(
                    (link) => link.provider === "kagane",
                  )?.externalId;
                  if (currentId && !candidates.has(currentId)) {
                    const details = await client.details(currentId);
                    candidates.set(currentId, {
                      series_id: currentId,
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
                      checked.set(book.series_id, {
                        ...candidate,
                        ...(candidate.reasons.length === 0 && {
                          coverage: await client.coverage(book.series_id),
                        }),
                      });
                    }
                  }
                  selected = selectKaganeCandidate([...checked.values()], priority);
                  if (checked.size === 0) {
                    note = `UNMATCHED ${row.id} ${row.title}`;
                  } else if (!selected) {
                    outcome = "ambiguous";
                    note = `${checked.size === 1 ? "UNVERIFIED" : "AMBIGUOUS"} ${row.id} ${row.title}: ${[...checked.values()].map((candidate) => `${candidate.id} [${candidate.source}; books=${candidate.books}; IDs=${candidate.matchedIds.join("+") || "none"}; ${candidate.reasons.join(", ") || "source/identity tie"}]`).join("; ")}`;
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
                      candidates: [...checked.values()],
                    });
                    throw error;
                  }
                  if (/Provider link conflict:/.test(errorMessage(error))) {
                    outcome = "conflicts";
                    note = `CONFLICT ${row.id}: ${errorMessage(error)}`;
                  } else {
                    outcome = "errors";
                    note = `ERROR ${row.id} ${row.title}: ${errorMessage(error)}`;
                  }
                }
                counts[outcome]++;
                record({
                  event: "entry",
                  entryId: row.id,
                  title: row.title,
                  outcome,
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
              event: "run",
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
              closeSync(reportFile);
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
