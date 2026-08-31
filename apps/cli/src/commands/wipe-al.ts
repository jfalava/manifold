import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  deleteActivitiesWithProgress,
  deleteEntriesWithProgress,
  fetchMangaActivities,
  fetchMangaEntries,
  fetchViewer,
  type Activity,
  type WipeListEntry,
} from "@/anilist-wipe";
import {
  abortFrame,
  closeFrame,
  confirmInFrame,
  createRun,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";

interface WipeCtx extends RunContext {
  entries: WipeListEntry[];
  activities: Activity[];
}

export const wipeAlCommand = Command.make("wipe-al", {
  yes: Flag.boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Skip the interactive confirmation prompts."),
  ),
  anilistToken: Flag.string("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription("Falls back to ANILIST_TOKEN / ALCHEMY_SECRET_ANILIST_TOKEN."),
  ),
}).pipe(
  Command.withDescription(
    "NUKE: delete ALL manga list entries and ALL manga-related activities on AniList. Anime is never touched.",
  ),
  Command.withHandler(({ yes, anilistToken }) => {
    const token =
      Option.getOrUndefined(anilistToken) ??
      process.env.ANILIST_TOKEN ??
      process.env.ALCHEMY_SECRET_ANILIST_TOKEN ??
      "";
    return Effect.gen(function* () {
      // Scan phase runs to completion before the interactive confirm so the
      // readline prompt never fights the listr2 renderer for the screen.
      const scan: WipeCtx = yield* Effect.tryPromise({
        try: async () => {
          openFrame("wipe-al");

          let viewerId: number | undefined;
          const run = createRun<WipeCtx>([
            {
              title: "AniList profile",
              task: async (_, task) => {
                makePhaseReporter(task).detail(
                  "Fetching your AniList profile…",
                );
                const viewer = await fetchViewer(token);
                makePhaseReporter(task).note(
                  `Signed in as ${viewer.name} (${viewer.id}).`,
                );
                viewerId = viewer.id;
              },
            },
            {
              title: "Fetch manga list entries",
              task: async (ctx, task) => {
                if (viewerId === undefined) {
                  throw new Error("Viewer lookup failed (is ANILIST_TOKEN set?)");
                }
                ctx.entries = await fetchMangaEntries(token, viewerId);
              },
            },
            {
              title: "Fetch manga-related activities",
              task: async (ctx, task) => {
                if (viewerId === undefined) {
                  throw new Error("Viewer lookup failed (is ANILIST_TOKEN set?)");
                }
                ctx.activities = await fetchMangaActivities(
                  token,
                  viewerId,
                  makePhaseReporter(task),
                );
              },
            },
          ]);

          try {
            return await run.run();
          } catch (error) {
            abortFrame();
            throw error;
          }
        },
        catch: (cause) =>
          new Error(cause instanceof Error ? cause.message : String(cause)),
      });

      if (scan.entries.length === 0 && scan.activities.length === 0) {
        closeFrame("Nothing to delete.");
        return;
      }

      const confirmed = yes
        ? true
        : yield* Effect.tryPromise(() =>
            confirmInFrame(
              `This permanently wipes ${scan.entries.length} list entries and ${scan.activities.length} activities from the manga side of your AniList account. Continue?`,
            ),
          );
      if (!confirmed) {
        closeFrame("Cancelled.");
        return;
      }

      yield* Effect.tryPromise({
        try: async () => {
          interface DeleteCtx extends RunContext {}

          const deleteTasks: Parameters<typeof createRun<DeleteCtx>>[0] = [];
          if (scan.entries.length > 0) {
            deleteTasks.push({
              title: `Delete ${scan.entries.length} list entries`,
              task: async (_, task) => {
                const result = await deleteEntriesWithProgress(
                  token,
                  scan.entries,
                  makePhaseReporter(task),
                );
                makePhaseReporter(task).note(
                  `Entries deleted=${result.ok} failed=${result.failed}`,
                );
              },
            });
          }
          if (scan.activities.length > 0) {
            deleteTasks.push({
              title: `Delete ${scan.activities.length} manga-related activities`,
              task: async (_, task) => {
                const result = await deleteActivitiesWithProgress(
                  token,
                  scan.activities,
                  makePhaseReporter(task),
                );
                makePhaseReporter(task).note(
                  `Activities deleted=${result.ok} failed=${result.failed} skipped=${result.skipped}`,
                );
              },
            });
          }

          const run = createRun<DeleteCtx>(deleteTasks);
          try {
            await run.run();
            closeFrame("Wipe complete.");
          } catch (error) {
            abortFrame();
            throw error;
          }
        },
        catch: (cause) =>
          new Error(cause instanceof Error ? cause.message : String(cause)),
      });
    }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
  }),
);
