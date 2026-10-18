/** @effect-diagnostics asyncFunction:off */
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type { ListrTask } from "listr2";
import { RegistryEntry } from "@manifold/contract";
import { errorMessage } from "@manifold/json";
import { apiCall, apiConfig, listRegistryRows, type RegistryRow } from "@/commands/toolbox";
import { loadRegistrySearchTitles, searchTitlesFor } from "@/registry-titles";
import { classifyPage, openBunBrowserView, type BrowserView } from "@/browser-view";
import { resolveValue } from "@/env-resolve";
import { cliError, sleepPromise, validateNonNegativeLimit } from "@/effect-kit";
import {
  createKaganeClient,
  hasExactKaganeTitle,
  KAGANE_ORIGIN,
  KaganeChallengeError,
  kaganeProfileDir,
  type KaganeBook,
} from "@/kagane";
import { resolveAniListToken } from "@/login/anilist";
import { matchesStatusFilter, parseStatusFilter, STATUS_FILTER_HINT } from "@/registry-status";
import { closeFrame, createRun, makePhaseReporter, openFrame, type RunContext } from "@/ui";

interface KaganeCtx extends RunContext {
  rows: readonly RegistryRow[];
  selected: readonly RegistryRow[];
}

export const kaganePrefillCommand = Command.make("kagane", {
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
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
    "Backfill unique Kagane title/alias matches. Dry-run by default; never replaces provider links.",
  ),
  Command.withHandler(
    ({ apply, limit, status, language, delay, chromeCdpUrl, apiOrigin, apiToken, anilistToken }) =>
      Effect.tryPromise({
        try: async () => {
          const maximum = Option.getOrUndefined(limit);
          validateNonNegativeLimit(maximum);
          if (!Number.isSafeInteger(delay) || delay < 0) {
            throw cliError("--delay must be a non-negative integer (milliseconds).");
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
          openFrame(`Kagane registry prefill → ${apply ? "apply" : "dry run"}`);
          const load: ListrTask<KaganeCtx> = {
            title: "Load registry rows",
            task: async (ctx, task) => {
              ctx.rows = await listRegistryRows(config);
              const eligible = ctx.rows.filter(
                (row) =>
                  !row.tombstoned &&
                  !row.providers.some((link) => link.provider === "kagane") &&
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
              if (chromeUrl) {
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
              const client = createKaganeClient({ delay, view });
              const sources = new Map(
                (await client.sources()).sources.map((source) => [source.source_id, source.title]),
              );
              const owners = new Map(
                ctx.rows.flatMap((row) =>
                  row.providers
                    .filter((link) => link.provider === "kagane")
                    .map((link) => [link.externalId, row.id] as const),
                ),
              );
              for (const [index, row] of ctx.selected.entries()) {
                try {
                  const titles = await loadRegistrySearchTitles(row, { anilistToken: anilist });
                  const candidates = new Map<string, KaganeBook>();
                  // Search every term before choosing, so aliases cannot hide a competing edition.
                  for (const title of searchTitlesFor(titles)) {
                    for (const book of await client.search(title, language)) {
                      if (
                        hasExactKaganeTitle(titles, [book.title, ...(book.alternate_titles ?? [])])
                      ) {
                        candidates.set(book.series_id, book);
                      }
                    }
                  }
                  if (candidates.size === 0) {
                    counts.unmatched++;
                    reporter.note(`UNMATCHED ${row.id} ${row.title}`);
                  } else if (candidates.size > 1) {
                    counts.ambiguous++;
                    reporter.note(
                      `AMBIGUOUS ${row.id}: ${[...candidates.values()]
                        .map(
                          (book) =>
                            `${book.series_id} [${sources.get(book.source_id ?? "") ?? book.source_id ?? "unknown source"}; books=${book.current_books ?? "?"}]`,
                        )
                        .join(", ")}`,
                    );
                  } else {
                    const book = [...candidates.values()][0]!;
                    const details = await client.details(book.series_id);
                    const names = [
                      details.title,
                      ...(details.series_alternate_titles ?? []).map((alias) => alias.title),
                    ];
                    const compatible =
                      hasExactKaganeTitle(titles, names) &&
                      details.translated_language === language &&
                      details.source_id === book.source_id &&
                      sources.has(details.source_id ?? "") &&
                      !details.edition_info?.trim() &&
                      (book.current_books ?? 0) > 0 &&
                      (!book.format || !details.format || book.format === details.format);
                    if (!compatible) {
                      counts.ambiguous++;
                      reporter.note(
                        `UNVERIFIED ${row.id} → ${book.series_id}: language=${details.translated_language ?? "?"}; source=${details.source_id ?? "?"}; edition=${details.edition_info ?? "none"}; books=${book.current_books ?? "?"}`,
                      );
                    } else if (
                      owners.has(book.series_id) &&
                      owners.get(book.series_id) !== row.id
                    ) {
                      counts.conflicts++;
                      reporter.note(
                        `CONFLICT ${row.id}: kagane:${book.series_id} already belongs to ${owners.get(book.series_id)}`,
                      );
                    } else {
                      if (apply) {
                        await apiCall(
                          config,
                          `/v1/entries/${encodeURIComponent(row.id)}/providers`,
                          "POST",
                          {
                            provider: "kagane",
                            externalId: book.series_id,
                            title: details.title,
                            onConflict: "reject",
                          },
                          RegistryEntry,
                        );
                      }
                      owners.set(book.series_id, row.id);
                      counts.matched++;
                      reporter.note(
                        `${apply ? "LINKED" : "WOULD LINK"} ${row.id} → kagane:${book.series_id} [${sources.get(details.source_id!)}]`,
                      );
                    }
                  }
                } catch (error) {
                  if (
                    error instanceof KaganeChallengeError ||
                    /Kagane Cloudflare challenge/.test(errorMessage(error))
                  ) {
                    throw error;
                  }
                  if (/Provider link conflict:/.test(errorMessage(error))) {
                    counts.conflicts++;
                    reporter.note(`CONFLICT ${row.id}: ${errorMessage(error)}`);
                  } else {
                    counts.errors++;
                    reporter.note(`ERROR ${row.id}: ${errorMessage(error)}`);
                  }
                }
                reporter.progress(index + 1, ctx.selected.length, Object.entries(counts));
              }
            },
          };
          try {
            await createRun<KaganeCtx>([load, sweep]).run({ rows: [], selected: [] });
            closeFrame(
              `${apply ? "Applied" : "Dry run"}: ${Object.entries(counts)
                .map(([name, count]) => `${count} ${name}`)
                .join("; ")}`,
            );
            if (counts.errors + counts.conflicts > 0) {
              throw cliError("Kagane prefill has errors/conflicts; inspect the report.");
            }
          } catch (error) {
            if (/Kagane Cloudflare challenge/.test(errorMessage(error))) {
              counts.challenged++;
            }
            closeFrame(
              `Stopped: ${Object.entries(counts)
                .map(([name, count]) => `${count} ${name}`)
                .join("; ")}. Earlier applied links, if any, remain saved.`,
            );
            throw error;
          } finally {
            view?.close();
          }
        },
        catch: (cause) => cliError(errorMessage(cause)),
      }),
  ),
);
