/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { RegistryEntry } from "@manifold/contract";
import { errorMessage } from "@manifold/json";
import { apiCall, apiConfig, listRegistryRows } from "@/commands/toolbox";
import { coverageDifference } from "@/chapter-coverage";
import { cliError, jsonBodyString, validateNonNegativeLimit } from "@/effect-kit";
import { loadRegistrySearchTitles } from "@/registry-titles";
import { resolveAniListToken } from "@/login/anilist";
import { openRegistryReport } from "@/registry-report";
import { matchesStatusFilter, parseStatusFilter, STATUS_FILTER_HINT } from "@/registry-status";
import {
  createXComicClient,
  findXComicCandidates,
  selectXComicCandidate,
  XComicBlockedError,
  XCOMIC_ORIGIN,
  type XComicCandidate,
} from "@/xcomic";
import { closeFrame, createProgress, frameDetail, openFrame } from "@/ui";

export const xcomicPrefillCommand = Command.make("xcomic", {
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
    Flag.withDescription("XComic language ID, e.g. en, pt_br or es_419."),
  ),
  origin: Flag.String("origin").pipe(
    Flag.withDefault(XCOMIC_ORIGIN),
    Flag.withDescription("Explicit XComic HTTPS mirror; no automatic failover."),
  ),
  delay: Flag.Int("delay").pipe(Flag.withDefault(1_500)),
  maxPages: Flag.Int("max-pages").pipe(Flag.withDefault(200)),
  report: Flag.String("report").pipe(Flag.optional),
  resume: Flag.String("resume").pipe(
    Flag.optional,
    Flag.withDescription("Resume a previous JSONL report; retry errors and challenges."),
  ),
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
  anilistToken: Flag.String("anilist-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Backfill XComic edition links using tracker IDs and complete chapter coverage. Dry-run by default; never replaces existing links.",
  ),
  Command.withHandler(
    ({
      apply,
      auditExisting,
      limit,
      status,
      language,
      origin,
      delay,
      maxPages,
      report,
      resume,
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
            throw cliError("--delay must be a non-negative integer.");
          }
          if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
            throw cliError("--max-pages must be a positive integer.");
          }
          if (!/^[a-z]{2,3}(?:_[a-z0-9]{2,3})?$/.test(language)) {
            throw cliError("--language must be an XComic language code such as en or pt_br.");
          }
          const config = await apiConfig(apiOrigin, apiToken);
          const statuses = parseStatusFilter(status);
          const token = await resolveAniListToken(Option.getOrUndefined(anilistToken));
          const client = createXComicClient({
            delay,
            maxPages,
            origin,
            onProgress: (message) => progress.detail(message),
          });
          const journal = openRegistryReport(
            "xcomic",
            apply,
            {
              apiOrigin: config.origin,
              language,
              auditExisting,
              origin,
              anilistAliases: Boolean(token),
            },
            Option.getOrUndefined(report),
            Option.getOrUndefined(resume),
          );
          const path = journal.path;
          const record = journal.record;
          const counts = {
            matched: 0,
            ambiguous: 0,
            unmatched: 0,
            conflicts: 0,
            errors: 0,
            blocked: 0,
          };
          let failure: string | undefined;
          openFrame(`XComic registry prefill → ${apply ? "apply" : "dry run"}`);
          frameDetail(`Report: ${path}`);
          const progress = createProgress("Search XComic and verify titles/coverage");
          try {
            record({
              event: "options",
              apply,
              auditExisting,
              origin,
              language,
              status,
              delay,
              maxPages,
            });
            const rows = await listRegistryRows(config);
            const eligible = rows.filter(
              (row) =>
                !row.tombstoned &&
                (auditExisting || !row.providers.some((link) => link.provider === "xcomic")) &&
                matchesStatusFilter(row.state?.status, statuses) &&
                !journal.skip(row),
            );
            const selectedRows = maximum === undefined ? eligible : eligible.slice(0, maximum);
            const owners = new Map(
              rows.flatMap((row) =>
                row.providers
                  .filter((link) => link.provider === "xcomic")
                  .map((link) => [link.externalId, row.id] as const),
              ),
            );
            for (const [index, row] of selectedRows.entries()) {
              progress.item(`${index + 1}/${selectedRows.length} ${row.title}`);
              const currentId = row.providers.find(
                (link) => link.provider === "xcomic",
              )?.externalId;
              let candidates: readonly XComicCandidate[] = [];
              let selected: XComicCandidate | undefined;
              let outcome: keyof typeof counts = "unmatched";
              let note = "";
              let retryable = false;
              try {
                const titles = await loadRegistrySearchTitles(row, {
                  anilistToken: token,
                  onIncomplete: () => {
                    retryable = true;
                  },
                });
                candidates = await findXComicCandidates(client, row, titles, language, currentId);
                selected = selectXComicCandidate(candidates);
                if (!candidates.length) {
                  note = `UNMATCHED ${row.id} ${row.title}`;
                } else if (!selected) {
                  outcome = "ambiguous";
                  note = `REVIEW ${row.id} ${row.title}: no unique identity-verified coverage winner`;
                } else if (owners.has(selected.id) && owners.get(selected.id) !== row.id) {
                  outcome = "conflicts";
                  note = `CONFLICT ${row.id}: xcomic:${selected.id} already belongs to ${owners.get(selected.id)}`;
                } else {
                  if (apply) {
                    await apiCall(
                      config,
                      `/v1/entries/${encodeURIComponent(row.id)}/providers`,
                      "POST",
                      {
                        provider: "xcomic",
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
                  note = `${apply ? "LINKED" : currentId ? "PROPOSED (existing link unchanged)" : "WOULD LINK"} ${row.id} → xcomic:${selected.id} [${selected.source}; ${selected.coverage?.count} chapters]`;
                }
              } catch (error) {
                outcome =
                  error instanceof XComicBlockedError
                    ? "blocked"
                    : /Provider link conflict:/.test(errorMessage(error))
                      ? "conflicts"
                      : "errors";
                note = `${outcome.toUpperCase()} ${row.id} ${row.title}: ${errorMessage(error)}`;
                if (error instanceof XComicBlockedError) {
                  failure = errorMessage(error);
                }
              }
              counts[outcome]++;
              journal.entry(row, {
                event: "entry",
                entryId: row.id,
                title: row.title,
                outcome,
                retryable,
                currentId: currentId ?? null,
                selectedId: selected?.id ?? null,
                coverageDifference: coverageDifference(
                  candidates.find((candidate) => candidate.id === currentId)?.coverage,
                  selected?.coverage,
                ),
                candidates,
                note,
              });
              frameDetail(note);
              progress.update(index + 1, selectedRows.length, "Checked");
              if (failure) {
                throw cliError(failure);
              }
            }
          } catch (error) {
            failure = errorMessage(error);
            throw error;
          } finally {
            progress.finish();
            try {
              record({
                event: "summary",
                completed: failure === undefined,
                counts,
                ...(failure !== undefined && { error: failure }),
              });
            } finally {
              journal.close();
              closeFrame(
                `${failure ? "Stopped" : counts.errors || counts.conflicts ? "Completed with errors" : apply ? "Applied" : "Dry run complete"}: ${jsonBodyString(counts)}. Report: ${path}`,
                failure !== undefined || counts.errors + counts.conflicts + counts.blocked > 0,
              );
            }
          }
          if (counts.errors || counts.conflicts || counts.blocked) {
            throw cliError(`XComic completed with errors; inspect ${path}`);
          }
        },
        catch: (cause) => cliError(errorMessage(cause)),
      }),
  ),
);
