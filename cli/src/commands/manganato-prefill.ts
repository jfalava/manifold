/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type { ListrTask } from "listr2";
import { RegistryEntry } from "@manifold/contract";
import { errorMessage } from "@manifold/json";
import { apiCall, apiConfig, listRegistryRows, type RegistryRow } from "@/commands/toolbox";
import { classifyPage, openBunBrowserView, type BrowserView } from "@/browser-view";
import { resolveValue } from "@/env-resolve";
import { cliError, jsonBodyString, sleepPromise, validateNonNegativeLimit } from "@/effect-kit";
import {
  createManganatoClient,
  hasManganatoAuthor,
  hasManganatoTitle,
  loadManganatoChapterReference,
  loadManganatoIdentity,
  MANGANATO_ORIGIN,
  MANGANATO_SEARCH_POLICY,
  MANGANATO_SELECTION_POLICY,
  ManganatoBlockedError,
  ManganatoPageBudgetError,
  manganatoMatchEvidence,
  manganatoRescueQueries,
  manganatoSearchPlans,
  recommendManganatoCandidate,
  selectManganatoCandidate,
  type ManganatoCandidate,
  type ManganatoChapterReference,
  type ManganatoIdentity,
  type ManganatoSelection,
} from "@/manganato";
import { withProgramStatus } from "@/program-status";
import { openRegistryReport } from "@/registry-report";
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
  acceptRecommendations: Flag.Boolean("accept-recommendations").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Accept inferred duplicate recommendations with continuous integer chapters; writes still require --apply.",
    ),
  ),
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
    Flag.optional,
    Flag.withDescription(
      "Hard page ceiling per query. Default: 5, with one candidate-bearing search continued to 20.",
    ),
  ),
  report: Flag.String("report").pipe(
    Flag.optional,
    Flag.withDescription(
      "New JSONL report path; default ~/.manifold/reports/manganato-<run>.jsonl.",
    ),
  ),
  resume: Flag.String("resume").pipe(
    Flag.optional,
    Flag.withDescription("Resume a previous JSONL report; retry errors and challenges."),
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
    "Backfill MangaNato links through Chrome using exact titles and author/chapter evidence. Dry-run by default; never replaces links.",
  ),
  Command.withHandler(
    ({
      apply,
      acceptRecommendations,
      limit,
      status,
      delay,
      maxPages: pageLimit,
      report,
      resume,
      chromeCdpUrl,
      apiOrigin,
      apiToken,
    }) =>
      withProgramStatus((programStatus) =>
        Effect.tryPromise({
          try: async () => {
            programStatus.phase("Preparing MangaNato registry");
            const maximum = Option.getOrUndefined(limit);
            validateNonNegativeLimit(maximum);
            if (!Number.isSafeInteger(delay) || delay < 0) {
              throw cliError("--delay must be a non-negative integer (milliseconds).");
            }
            const maxPages = Option.getOrElse(pageLimit, () => 5);
            const continuationMaxPages = Option.getOrElse(pageLimit, () => 20);
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
              deferred: 0,
            };
            const retryWhen = {
              maxPages,
              continuationMaxPages,
              searchPolicy: MANGANATO_SEARCH_POLICY,
              selectionPolicy: MANGANATO_SELECTION_POLICY,
              acceptRecommendations,
            };
            const journal = openRegistryReport(
              "manganato",
              apply,
              { apiOrigin: config.origin, language: "en" },
              Option.getOrUndefined(report),
              Option.getOrUndefined(resume),
            );
            const reportPath = journal.path;
            const record = journal.record;
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
                    matchesStatusFilter(row.state?.status, statuses) &&
                    !journal.skip(row, retryWhen),
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
                const onBlocked = async (error: ManganatoBlockedError): Promise<void> => {
                  progress(error.message);
                  if (!process.stdin.isTTY) {
                    throw error;
                  }
                  programStatus.phase("Waiting for MangaNato in Chrome");
                  progress(
                    "PAUSED: inspect MangaNato in regular Chrome and resolve any challenge, then press Enter here to retry the same request. Ctrl-C stops the run.",
                  );
                  // Listr owns output. Read input without a second terminal renderer or prompt.
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
                      progress("Retrying the paused MangaNato request");
                      programStatus.phase(
                        apply ? "Checking and linking MangaNato" : "Checking MangaNato links",
                      );
                      return;
                    }
                    throw error; // EOF or cancellation is not permission to retry.
                  } catch {
                    // Keep cancellation terminal instead of turning it into a skipped row.
                    throw error;
                  } finally {
                    reader.close();
                    process.stdin.pause();
                  }
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
                  if (classifyPage(current, "") === "challenge") {
                    await onBlocked(
                      new ManganatoBlockedError({
                        message: "MangaNato Cloudflare challenge; solve it in regular Chrome.",
                      }),
                    );
                    attempt = -1;
                    continue;
                  }
                  if (current.startsWith(`${MANGANATO_ORIGIN}|complete|`)) {
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
                  catalog: journal.catalog,
                  onCache: record,
                  onBlocked,
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
                  let selected: ManganatoSelection | undefined;
                  let recommendation: ReturnType<typeof recommendManganatoCandidate>;
                  let acceptedRecommendation = false;
                  const candidates = new Map<string, ManganatoCandidate>();
                  const knownCandidateIds = new Set<string>();
                  const priorCandidateIds = new Set<string>();
                  let titles: readonly string[] = [row.title];
                  let authors: readonly string[] = [];
                  let identity: ManganatoIdentity = { titles, authors };
                  let chapterReference: ManganatoChapterReference | undefined;
                  const queries: string[] = [];
                  const cappedQueries: string[] = [];
                  let plannedQueries: readonly string[] = [];
                  let rescueQueries: readonly string[] = [];
                  let fullTitleQueries: readonly string[] = [];
                  let omittedTitles: readonly string[] = [];
                  const attempts: {
                    query: string;
                    status: string;
                    candidateIds: string[];
                    maxPages: number;
                    continued?: boolean;
                  }[] = [];
                  let usefulQuery: string | null = null;
                  let stopReason = "exhausted_plans";
                  let deferredReason: string | undefined;
                  let blocked: ManganatoBlockedError | undefined;
                  let retryable = false;
                  try {
                    const loadedIdentity = await loadManganatoIdentity(row, progress, () => {
                      retryable = true;
                    });
                    identity = loadedIdentity;
                    titles = identity.titles;
                    authors = identity.authors;
                    // Revisit known competitors even if the discovery queries changed since that report.
                    for (const id of journal.candidateIds(row)) {
                      knownCandidateIds.add(id);
                      priorCandidateIds.add(id);
                    }
                    for (const id of identity.confirmedCandidateIds ?? []) {
                      knownCandidateIds.add(id);
                    }
                    // Preserve other IDs as report history, but an explicit choice needs only
                    // its own details. Rejected editions must not block it with failed reads.
                    const requiredIds = identity.preferredCandidateId
                      ? [identity.preferredCandidateId]
                      : knownCandidateIds;
                    for (const id of requiredIds) {
                      const details = await client.details(id);
                      if (!hasManganatoTitle(titles, [details.title, ...details.aliases])) {
                        throw cliError(
                          `Known competitor ${id} no longer matches the identity; review required`,
                        );
                      }
                      candidates.set(details.id, details);
                    }
                    const manualDuplicate = (): boolean =>
                      candidates.size > 1 &&
                      [...candidates.values()].some((item) => {
                        const evidence = manganatoMatchEvidence(identity, item);
                        return evidence.author === "missing" && !evidence.userConfirmed;
                      });
                    const confirmed = (identity.confirmedCandidateIds?.length ?? 0) > 0;
                    const plans =
                      confirmed || identity.manualReview
                        ? []
                        : manganatoSearchPlans(loadedIdentity.discoveryTitles);
                    const wordQueries = [...new Set(plans.flatMap((plan) => plan.queries))];
                    rescueQueries =
                      confirmed || identity.manualReview
                        ? []
                        : manganatoRescueQueries(loadedIdentity.fallbackTitles, wordQueries);
                    fullTitleQueries =
                      confirmed || identity.manualReview
                        ? []
                        : [
                            ...new Set(
                              loadedIdentity.fallbackTitles
                                .filter(
                                  (title) =>
                                    !/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(
                                      title,
                                    ),
                                )
                                .map((title) => title.trim().toLowerCase().replace(/\s+/g, " "))
                                .filter((query) => /[\p{L}\p{N}]/u.test(query)),
                            ),
                          ]
                            .filter(
                              (query) =>
                                !wordQueries.includes(query) && !rescueQueries.includes(query),
                            )
                            .slice(0, 3);
                    plannedQueries = [...wordQueries, ...rescueQueries, ...fullTitleQueries];
                    omittedTitles = loadedIdentity.discoveryTitles.filter(
                      (title) =>
                        !plans.some((plan) => plan.title === title) &&
                        !fullTitleQueries.includes(title.trim().toLowerCase().replace(/\s+/g, " ")),
                    );
                    if (identity.manualReview) {
                      stopReason = "manual_publication_version";
                    } else if (identity.preferredCandidateId) {
                      stopReason = "user_selected_listing";
                      progress("Revalidating user-selected listing");
                    } else if (confirmed) {
                      stopReason = "user_confirmed_candidates";
                      progress("Revalidating user-confirmed listings and known competitors");
                    } else if (!plannedQueries.length) {
                      deferredReason = "no_query";
                      stopReason = "no_query";
                    }
                    for (const continued of [false, true]) {
                      if (usefulQuery || (continued && continuationMaxPages <= maxPages)) {
                        break;
                      }
                      // Extend only one candidate-bearing cap, preferring a single-word search.
                      const passQueries = continued
                        ? attempts
                            .filter(
                              (attempt) =>
                                attempt.status === "capped" && attempt.candidateIds.length,
                            )
                            .sort(
                              (a, b) =>
                                Number(fullTitleQueries.includes(a.query)) -
                                Number(fullTitleQueries.includes(b.query)),
                            )
                            .slice(0, 1)
                            .map((attempt) => attempt.query)
                        : plannedQueries;
                      for (const query of passQueries) {
                        // Do not use full titles to resolve established ambiguity or word hits.
                        // Continuing the same validated search does not add another fallback.
                        if (
                          !continued &&
                          fullTitleQueries.includes(query) &&
                          ((candidates.size > 1 &&
                            journal.checkpoint(row)?.outcome === "ambiguous") ||
                            attempts.some((attempt) => attempt.candidateIds.length))
                        ) {
                          break;
                        }
                        if (continued) {
                          progress(
                            `Continuing candidate-bearing query ${query} to ${continuationMaxPages} pages`,
                          );
                        } else if (rescueQueries.includes(query)) {
                          progress(`Trying canonical word fallback: ${query}`);
                        } else if (fullTitleQueries.includes(query)) {
                          progress(`Trying full-title fallback: ${query}`);
                        }
                        const attempt: (typeof attempts)[number] = attempts.find(
                          (item) => item.query === query,
                        ) ?? {
                          query,
                          status: "failed",
                          candidateIds: [],
                          maxPages,
                        };
                        if (continued) {
                          attempt.maxPages = continuationMaxPages;
                          attempt.continued = true;
                          attempt.status = "failed";
                        } else {
                          queries.push(query);
                          attempts.push(attempt);
                        }
                        let foundCandidate = false;
                        try {
                          for await (const hits of client.search(query, attempt.maxPages)) {
                            for (const hit of hits) {
                              if (!hasManganatoTitle(titles, [hit.title])) {
                                continue;
                              }
                              // Preserve the competitor even if its detail read is interrupted.
                              knownCandidateIds.add(hit.id);
                              const details =
                                candidates.get(hit.id) ?? (await client.details(hit.id));
                              if (!hasManganatoTitle(titles, [details.title, ...details.aliases])) {
                                continue;
                              }
                              foundCandidate = true;
                              candidates.set(hit.id, details);
                              if (!attempt.candidateIds.includes(hit.id)) {
                                attempt.candidateIds.push(hit.id);
                              }
                            }
                          }
                          attempt.status = "complete";
                          const capIndex = cappedQueries.indexOf(query);
                          if (capIndex !== -1) {
                            cappedQueries.splice(capIndex, 1);
                          }
                        } catch (error) {
                          if (!(error instanceof ManganatoPageBudgetError)) {
                            stopReason = "failed_query";
                            throw error;
                          }
                          attempt.status = "capped";
                          if (!cappedQueries.includes(query)) {
                            cappedQueries.push(query);
                          }
                          progress(`${error.message}; checking remaining search fallbacks`);
                          continue;
                        }
                        if (foundCandidate) {
                          usefulQuery = query;
                          stopReason = "useful_complete_query";
                          progress(
                            `Completed useful query ${query}; remaining title queries omitted (limited discovery)`,
                          );
                          break;
                        }
                      }
                    }
                    if (!usefulQuery && cappedQueries.length) {
                      deferredReason = "page_budget";
                    }
                    if (
                      !confirmed &&
                      !identity.manualReview &&
                      !usefulQuery &&
                      candidates.size &&
                      !deferredReason
                    ) {
                      deferredReason = "no_useful_query";
                    }
                    if (!identity.manualReview && !deferredReason) {
                      // Read duplicate inventories first: a verified-author anchor can avoid a canonical lookup.
                      if (candidates.size > 1) {
                        for (const [id, candidate] of candidates) {
                          const coverage = await client.coverage(id);
                          candidates.set(id, { ...candidate, coverage });
                          progress(`${id}: ${coverage.count} distinct ${coverage.unit}`);
                        }
                      }
                      if (
                        [...candidates.values()].some((candidate) => {
                          const evidence = manganatoMatchEvidence(identity, candidate, [
                            ...candidates.values(),
                          ]);
                          return (
                            !evidence.userConfirmed &&
                            evidence.author === "different" &&
                            !evidence.chapterSupport
                          );
                        })
                      ) {
                        chapterReference = await loadManganatoChapterReference(
                          row,
                          progress,
                          () => {
                            retryable = true;
                          },
                        );
                      }
                      if (
                        chapterReference?.status === "FINISHED" &&
                        (chapterReference.chapters ?? 0) >= 10
                      ) {
                        for (const [id, candidate] of candidates) {
                          if (candidate.coverage) {
                            continue;
                          }
                          const coverage = await client.coverage(id);
                          candidates.set(id, { ...candidate, coverage });
                          progress(`${id}: ${coverage.count} distinct ${coverage.unit}`);
                        }
                      }
                    }
                    const matchingIdentity = {
                      ...identity,
                      ...(chapterReference && { chapterReference }),
                    };
                    selected = !deferredReason
                      ? selectManganatoCandidate(matchingIdentity, [...candidates.values()])
                      : undefined;
                    if (
                      !selected &&
                      !deferredReason &&
                      !retryable &&
                      usefulQuery &&
                      !cappedQueries.length &&
                      attempts.every((attempt) => attempt.status === "complete")
                    ) {
                      recommendation = recommendManganatoCandidate(matchingIdentity, [
                        ...candidates.values(),
                      ]);
                    }
                    if (acceptRecommendations && recommendation?.acceptEligible) {
                      const candidate = candidates.get(recommendation.candidateId)!;
                      selected = {
                        ...candidate,
                        ...(recommendation.selection && {
                          selection: recommendation.selection,
                        }),
                      };
                      acceptedRecommendation = true;
                    }
                    if (identity.manualReview) {
                      outcome = "ambiguous";
                      note = "Publication title/version conflict; user requested manual selection";
                    } else if (deferredReason) {
                      outcome = "deferred";
                      note =
                        deferredReason === "no_query"
                          ? "No usable English/romanized title words; not a catalog miss"
                          : deferredReason === "no_useful_query"
                            ? "No completed query returned an exact-title candidate; known competitors retained for review"
                            : `Search page budget exhausted; no automatic link. Resume skips until --max-pages or search policy changes`;
                    } else if (manualDuplicate() && !acceptedRecommendation) {
                      outcome = "ambiguous";
                      note =
                        "Duplicate titles with missing author evidence; manual review required";
                    } else if (selected) {
                      if (owners.has(selected.id) && owners.get(selected.id) !== row.id) {
                        outcome = "conflicts";
                        note = `manganato:${selected.id} already belongs to ${owners.get(selected.id)}`;
                      } else {
                        if (acceptedRecommendation || selected.selection) {
                          // Surface inferred identity and losses before any provider write.
                          const decision = {
                            event: "decision",
                            entryId: row.id,
                            title: row.title,
                            candidateId: selected.id,
                            apply,
                            acceptedRecommendation,
                            recommendation: recommendation ?? null,
                            selection: selected.selection ?? null,
                            titles: [...titles],
                            authors: [...authors],
                            candidates: [...candidates.values()].map((candidate) => ({
                              id: candidate.id,
                              title: candidate.title,
                              authors: [...candidate.authors],
                              evidence: manganatoMatchEvidence(matchingIdentity, candidate, [
                                ...candidates.values(),
                              ]),
                              coverage: {
                                unit: candidate.coverage!.unit,
                                count: candidate.coverage!.count,
                                integerChapters: candidate.coverage!.numbers.filter(
                                  (number) => number >= 1 && Number.isInteger(number),
                                ).length,
                                latestChapterUpdatedAt:
                                  candidate.coverage!.latestChapterUpdatedAt ?? null,
                              },
                            })),
                          };
                          record(decision);
                          reporter.note(`SELECTION ${jsonBodyString(decision)}`);
                        }
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
                        const evidence = manganatoMatchEvidence(matchingIdentity, selected, [
                          ...candidates.values(),
                        ]);
                        const basis = acceptedRecommendation
                          ? "explicitly accepted duplicate inference"
                          : identity.preferredCandidateId
                            ? "user-selected listing"
                            : evidence.userConfirmed
                              ? "user-confirmed work/listing identity"
                              : evidence.author === "verified"
                                ? "author/artist"
                                : evidence.overlap.length
                                  ? "chapter-number overlap with a verified-author listing despite different credits"
                                  : "canonical chapter support despite different author names";
                        note = `${apply ? "LINKED" : "WOULD LINK"} manganato:${selected.id}; exact title + ${basis}; evidence score ${evidence.score}${selected.coverage ? `; coverage: ${selected.coverage.count} distinct chapters` : ""}${selected.selection ? `; active-listing fallback; lost positions: ${jsonBodyString(selected.selection.lostPositions)}` : ""}`;
                      }
                    } else if (candidates.size) {
                      outcome = "ambiguous";
                      note =
                        candidates.size > 1 &&
                        [...candidates.values()].every(
                          (candidate) =>
                            manganatoMatchEvidence(matchingIdentity, candidate, [
                              ...candidates.values(),
                            ]).eligible,
                        )
                          ? "Duplicate title candidates have tied, empty or incomparable chapter coverage"
                          : "Title/author/chapter evidence is insufficient; missing credits require manual review";
                    }
                    if (recommendation && !acceptedRecommendation) {
                      note += `; REVIEW ONLY: recommend manganato:${recommendation.candidateId} (${recommendation.basis}); ${recommendation.acceptEligible ? "requires --accept-recommendations" : "sparse integer coverage; cannot accept automatically"}; not linked`;
                    }
                  } catch (error) {
                    outcome =
                      error instanceof ManganatoBlockedError && error.reason !== "timeout"
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
                  journal.entry(row, {
                    event: "entry",
                    entryId: row.id,
                    title: row.title,
                    outcome,
                    retryable,
                    searchPolicy: MANGANATO_SEARCH_POLICY,
                    selectionPolicy: MANGANATO_SELECTION_POLICY,
                    retryWhen,
                    deferredReason: deferredReason ?? null,
                    note,
                    titles: [...titles],
                    authors: [...authors],
                    chapterReference: chapterReference
                      ? { ...chapterReference, titles: [...chapterReference.titles] }
                      : null,
                    queries: [...queries],
                    cappedQueries,
                    discovery: {
                      limitedCoverage: true,
                      plannedQueries: [...plannedQueries],
                      rescueQueries: [...rescueQueries],
                      fullTitleQueries: [...fullTitleQueries],
                      attempts,
                      omittedQueries: plannedQueries.filter((query) => !queries.includes(query)),
                      omittedTitles: omittedTitles.map((title) => ({
                        title,
                        reason: manganatoSearchPlans([title]).length
                          ? "plan_limit_or_duplicate"
                          : "no_usable_latin_query",
                      })),
                      usefulQuery,
                      stopReason,
                    },
                    selectedId: selected?.id ?? null,
                    selection: selected?.selection ?? null,
                    acceptedRecommendation,
                    recommendation: recommendation ?? null,
                    candidateIds: [...new Set([...knownCandidateIds, ...candidates.keys()])],
                    candidates: [...candidates.values()].map((candidate) => ({
                      ...candidate,
                      origin: {
                        checkpoint: priorCandidateIds.has(candidate.id),
                        userConfirmed:
                          identity.confirmedCandidateIds?.includes(candidate.id) ?? false,
                        queries: attempts
                          .filter((attempt) => attempt.candidateIds.includes(candidate.id))
                          .map((attempt) => attempt.query),
                      },
                      exactTitle: hasManganatoTitle(titles, [
                        candidate.title,
                        ...candidate.aliases,
                      ]),
                      authorMatch: hasManganatoAuthor(authors, candidate.authors),
                      evidence: manganatoMatchEvidence(
                        {
                          ...identity,
                          titles,
                          authors,
                          ...(chapterReference && { chapterReference }),
                        },
                        candidate,
                        [...candidates.values()],
                      ),
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
                event: "options",
                apply,
                acceptRecommendations,
                status,
                delay,
                maxPages,
                continuationMaxPages,
                language: "en",
                identity:
                  "exact title + author/artist or chapter support; duplicates ranked by distinct chapter coverage; limited discovery",
              });
              await createRun<ManganatoCtx>([load, sweep]).run({ rows: [], selected: [] });
            } catch (error) {
              failure = errorMessage(error);
              if (
                error instanceof ManganatoBlockedError &&
                error.reason !== "timeout" &&
                counts.challenged === 0
              ) {
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
                journal.close();
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
