/** @effect-diagnostics asyncFunction:off */
import { cliError, runHost } from "@/effect-kit";
import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type { ListrTask } from "listr2";
import { errorMessage } from "@manifold/json";

import {
  fetchFollowedMangaIds,
  fetchMangaDexTitles,
  mangadexCredentialFlags,
  openMangaDexSession,
  requireMangaDexCredentials,
  runMangaDexWrites,
} from "@/mangadex-session";
import {
  abortFrame,
  closeFrame,
  createRun,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import { MangaDexReadingStatus } from "@manifold/mangadex";

interface UnfollowCtx extends RunContext {
  droppedIds: readonly string[];
  followedDroppedIds: readonly string[];
  titles: Readonly<Record<string, string>>;
}

const READ_SPACING_MS = 250;
const WRITE_SPACING_MS = 220;
const DETAIL_LINE_CAP = 40;

const VALID_STATUSES = MangaDexReadingStatus.literals;
const isReadingStatus = Schema.is(MangaDexReadingStatus);

const parseList = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

export const unfollowDroppedCommand = Command.make(
  "unfollow-dropped",
  {
    status: Flag.String("status").pipe(
      Flag.withDefault("dropped"),
      Flag.withDescription(
        `Reading status(es) to unfollow. Comma-separated; one of: ${VALID_STATUSES.join(", ")}. Default: dropped.`,
      ),
    ),
    apply: Flag.Boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Actually unfollow on MangaDex. Default is a dry run."),
    ),
    ...mangadexCredentialFlags,
  },
  ({ status, apply, ...credentialFlags }) =>
    Effect.gen(function* () {
      const credentials = yield* requireMangaDexCredentials(credentialFlags);

      const targetStatuses = parseList(status);

      const invalid = targetStatuses.filter((s) => !isReadingStatus(s));

      if (invalid.length > 0) {
        return yield* cliError(
          `Invalid --status values: ${invalid.join(", ")}. Choose from: ${VALID_STATUSES.join(", ")}.`,
        );
      }

      if (targetStatuses.length === 0) {
        return yield* cliError("--status cannot be empty.");
      }

      yield* Effect.tryPromise({
        try: async () => {
          openFrame(
            `Unfollow dropped → ${targetStatuses.join(",")} ${apply ? "(apply)" : "(dry run)"}`,
          );

          const session = await openMangaDexSession(credentials);

          const fetchStatusesTask: ListrTask<UnfollowCtx> = {
            title: "Fetch reading statuses",
            task: async (ctx, task) => {
              const statuses = await runHost(session.client().readingStatuses());

              const droppedIds = Object.entries(statuses)
                .filter(([, s]) => targetStatuses.includes(s))
                .map(([id]) => id);

              ctx.droppedIds = droppedIds;
              makePhaseReporter(task).note(
                `${Object.keys(statuses).length} library entries · ${droppedIds.length} with status ${targetStatuses.join(", ")}.`,
              );
            },
            rendererOptions: { outputBar: Infinity },
          };

          const resolveFollowedTask: ListrTask<UnfollowCtx> = {
            title: "Resolve followed state for dropped entries",
            task: async (ctx, task) => {
              const reporter = makePhaseReporter(task);

              if (ctx.droppedIds.length === 0) {
                ctx.followedDroppedIds = [];
                ctx.titles = {};
                reporter.note("No entries match --status; nothing to do.");

                return;
              }

              // Paginate the full followed-manga list and intersect with droppedIds.
              // This is cheaper than N individual isFollowingManga checks and lets
              // the dry run list be exact. DELETE /manga/{id}/follow is idempotent
              // (404 is swallowed), but reporting needs the real followed set.
              const followed = await fetchFollowedMangaIds(
                session.client(),
                READ_SPACING_MS,
                (count, total) => reporter.progress(count, total, [["followed", count]]),
              );

              const followedDroppedIds = ctx.droppedIds.filter((id) => followed.has(id));
              ctx.followedDroppedIds = followedDroppedIds;
              reporter.note(
                `${followedDroppedIds.length} followed of ${ctx.droppedIds.length} ${targetStatuses.join(", ")} entries.` +
                  (followedDroppedIds.length === 0 ? " Nothing to unfollow." : ""),
              );

              if (followedDroppedIds.length === 0) {
                ctx.titles = {};

                return;
              }

              ctx.titles = await fetchMangaDexTitles(
                session.client(),
                followedDroppedIds,
                READ_SPACING_MS,
              );
            },
            rendererOptions: { outputBar: 1, persistentOutput: true },
          };

          const run = createRun<UnfollowCtx>(
            apply
              ? [
                  fetchStatusesTask,
                  resolveFollowedTask,
                  {
                    title: `Unfollow ${targetStatuses.join(", ")} entries`,
                    task: async (ctx, task) => {
                      const reporter = makePhaseReporter(task);

                      if (ctx.followedDroppedIds.length === 0) {
                        reporter.note("Nothing to do.");

                        return;
                      }

                      await runMangaDexWrites(session, reporter, {
                        ids: ctx.followedDroppedIds,
                        titles: ctx.titles,
                        write: (client, mangaId) => client.unfollowManga(mangaId),
                        verb: "unfollowed",
                        spacingMs: WRITE_SPACING_MS,
                        listWritten: true,
                      });
                    },
                    rendererOptions: { outputBar: 1, persistentOutput: true },
                  },
                ]
              : [
                  fetchStatusesTask,
                  resolveFollowedTask,
                  {
                    title: "Preview",
                    task: async (ctx, task) => {
                      const reporter = makePhaseReporter(task);

                      for (const mangaId of ctx.followedDroppedIds.slice(0, DETAIL_LINE_CAP)) {
                        reporter.note(`${ctx.titles[mangaId] ?? "(untitled)"} [${mangaId}]`);
                      }

                      if (ctx.followedDroppedIds.length > DETAIL_LINE_CAP) {
                        reporter.note(
                          `…and ${ctx.followedDroppedIds.length - DETAIL_LINE_CAP} more`,
                        );
                      }

                      reporter.note(
                        `Dry run: would unfollow ${ctx.followedDroppedIds.length} entries (${targetStatuses.join(", ")}). Re-run with --apply.`,
                      );
                    },
                    rendererOptions: { outputBar: Infinity, persistentOutput: true },
                  },
                ],
          );

          try {
            await run.run();
            closeFrame(apply ? "Unfollow finished" : "Dry run finished");
          } catch (error) {
            abortFrame();
            throw error;
          }
        },
        catch: (cause) => cliError(errorMessage(cause)),
      }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
    }),
).pipe(
  Command.withDescription(
    "Uncheck the Follow box on MangaDex entries with a given reading status (default: dropped).",
  ),
);
