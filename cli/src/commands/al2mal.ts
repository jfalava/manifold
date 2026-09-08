import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { AuthConnection } from "@manifold/contract";
import { errorMessage } from "@manifold/json";

import { fetchAniListMangaEntries } from "@/anilist";
import { createMalTitleSearch, runAl2mal, type Al2malReport } from "@/al2mal-core";
import { apiCall, apiConfig } from "@/commands/toolbox";
import { resolveValue } from "@/env-resolve";
import { resolveAniListToken } from "@/login/anilist";
import { loadMalSession, saveMalSession } from "@/login/mal-session";
import { createMalClient } from "@/mal";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";

interface Al2malCtx extends RunContext {
  report?: Al2malReport;
}

export const al2malCommand = Command.make("anilist-to-mal", {
  anilistToken: Flag.string("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList access token override. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
    ),
  ),
  malToken: Flag.string("mal-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "Overrides keychain login. Prefer MANIFOLD_MAL_TOKEN to keep tokens out of shell history.",
    ),
  ),
  apply: Flag.boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Write MAL manga list status and chapter progress. Default is a read-only dry run.",
    ),
  ),
  backupPaused: Flag.boolean("backup-paused").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Acknowledge all other MAL writers are paused/disconnected. Required with --apply.",
    ),
  ),
  skipProgress: Flag.boolean("skip-progress").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Do not seed num_chapters_read from AniList progress."),
  ),
  limit: Flag.integer("limit").pipe(
    Flag.optional,
    Flag.withDescription("Only process the first N AniList entries after export."),
  ),
  apiOrigin: Flag.string("api-origin").pipe(
    Flag.optional,
    Flag.withDescription(
      "Personal API origin for the backup-connection check. Falls back to MANIFOLD_API_ORIGIN.",
    ),
  ),
  apiToken: Flag.string("api-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "Personal API token for the backup-connection check. Falls back to MANIFOLD_TOKEN.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Populate MAL manga from your AniList list (status + chapter progress). List↔list only.",
  ),
  Command.withHandler(
    ({ anilistToken, malToken, apply, backupPaused, skipProgress, limit, apiOrigin, apiToken }) =>
      Effect.tryPromise({
        try: async () => {
          if (apply && !backupPaused) {
            throw new Error(
              "Pause/disconnect other MAL writers, then pass --backup-paused with --apply.",
            );
          }

          openFrame(`migrate anilist-to-mal ${apply ? "(apply)" : "(dry run)"}`);

          if (resolveValue(apiToken, "MANIFOLD_TOKEN")) {
            const connection = await apiCall(
              apiConfig(apiOrigin, apiToken),
              "/v1/auth/mal",
              "GET",
              undefined,
              AuthConnection,
            );
            if (connection.connected) {
              if (apply) {
                throw new Error(
                  "The Manifold API is still connected to MAL. Disconnect its MAL backup before importing; --backup-paused does not override this check.",
                );
              }
              frameDetail(
                "Warning: Manifold's MAL backup is connected and can overwrite imported entries. Disconnect it before --apply.",
              );
            }
          } else {
            frameDetail(
              "API backup connection not checked: MANIFOLD_TOKEN is unset. Verify other writers are paused yourself.",
            );
          }

          const anilist = (await resolveAniListToken(Option.getOrUndefined(anilistToken))) ?? "";
          if (!anilist) {
            throw new Error(
              "Missing AniList token: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.",
            );
          }

          const accessToken = resolveValue(malToken, "MANIFOLD_MAL_TOKEN");
          const session = accessToken ? undefined : await loadMalSession();
          if (!accessToken && !session) {
            throw new Error(
              "Missing MAL token: run login mal, pass --mal-token, or set MANIFOLD_MAL_TOKEN.",
            );
          }

          const malClientId = process.env.MANIFOLD_MAL_CLIENT_ID ?? session?.clientId;
          if (!malClientId) {
            throw new Error(
              "Missing MANIFOLD_MAL_CLIENT_ID for MAL title search (public client id).",
            );
          }

          const client = createMalClient({
            accessToken,
            session,
            clientSecret: process.env.MANIFOLD_MAL_CLIENT_SECRET,
            saveSession: saveMalSession,
          });
          const search = createMalTitleSearch(malClientId);

          const run = createRun<Al2malCtx>([
            {
              title: apply ? "Match AniList → MAL and write" : "Match AniList → MAL (dry run)",
              task: async (ctx, task) => {
                const reporter = makePhaseReporter(task);
                reporter.detail("Fetching AniList manga list…");
                let entries = await fetchAniListMangaEntries(anilist);
                const cap = Option.getOrUndefined(limit);
                if (cap !== undefined) {
                  if (!Number.isSafeInteger(cap) || cap < 1) {
                    throw new Error("--limit must be a positive integer.");
                  }
                  entries = entries.slice(0, cap);
                  reporter.note(`Limited to first ${entries.length} entries.`);
                } else {
                  reporter.note(`Fetched ${entries.length} AniList entries.`);
                }

                let matchedSoFar = 0;
                let unmatchedSoFar = 0;
                let errorsSoFar = 0;
                const tick = (index: number, total: number) => {
                  reporter.progress(index + 1, total, [
                    ["matched", matchedSoFar],
                    ["unmatched", unmatchedSoFar],
                    ["errors", errorsSoFar],
                  ]);
                };
                ctx.report = await runAl2mal({
                  entries,
                  search,
                  client,
                  dryRun: !apply,
                  includeProgress: !skipProgress,
                  onMatched: (_entry, index, total) => {
                    matchedSoFar += 1;
                    tick(index, total);
                  },
                  onUnmatched: (entry, index, total) => {
                    unmatchedSoFar += 1;
                    if (entry.reason.startsWith("MAL title search failed")) {
                      errorsSoFar += 1;
                    }
                    tick(index, total);
                  },
                  onWritten: (done, total) => {
                    reporter.progress(done, total, [["written", done]]);
                  },
                });
              },
            },
            {
              title: "Summarize",
              task: async (ctx, task) => {
                const report = ctx.report;
                if (!report) {
                  throw new Error("Migration produced no report.");
                }
                const reporter = makePhaseReporter(task);
                const prefix = report.dryRun ? "[dry run] " : "";
                reporter.note(
                  `${prefix}${report.scanned} scanned · ${report.matched.length} matched · ` +
                    `${report.unmatched.length} unmatched` +
                    (report.dryRun ? "" : ` · ${report.written} written · ${report.failed} failed`),
                );

                for (const entry of report.matched) {
                  const fields = [
                    `status=${entry.update.status}`,
                    entry.update.is_rereading ? "rereading" : undefined,
                    entry.update.num_chapters_read !== undefined
                      ? `ch=${entry.update.num_chapters_read}`
                      : undefined,
                    entry.method,
                    entry.error ? `ERROR: ${entry.error}` : undefined,
                  ]
                    .filter(Boolean)
                    .join(", ");
                  if (entry.error) {
                    reporter.problem(`${entry.title} → mal:${entry.malId} [${fields}]`);
                  } else {
                    reporter.detail(
                      `${entry.title} → mal:${entry.malId} (${entry.matchedTitle}) [${fields}]`,
                    );
                  }
                }
                for (const entry of report.unmatched) {
                  reporter.problem(`${entry.title} — ${entry.reason}`);
                }

                if (report.unmatched.length > 0 || report.failed > 0) {
                  process.exitCode = 1;
                }
              },
              rendererOptions: { outputBar: Infinity, persistentOutput: true },
            },
          ]);

          try {
            await run.run();
            closeFrame(
              apply
                ? "AniList → MAL import finished"
                : "AniList → MAL dry run finished (no writes)",
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
