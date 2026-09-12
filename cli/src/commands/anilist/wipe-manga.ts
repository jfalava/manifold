import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";
import { resolveAniListToken } from "@/login/anilist";
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

export const wipeAlMangaCommand = Command.make("manga", {
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Permanently delete the scanned AniList data (default: dry-run)."),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Skip the interactive confirmation when used with --apply."),
  ),
  anilistToken: Flag.String("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList access token override. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
    ),
  ),
  includeTextActivities: Flag.Boolean("include-text-activities").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Also delete TEXT activities (your posts). Off by default: post text cannot be reliably classified as manga-related, so this is a separate explicit opt-in — preview with a dry run first.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "NUKE: delete ALL manga list entries and manga list activities on AniList. TEXT posts are only deleted with --include-text-activities. Anime is never touched.",
  ),
  Command.withHandler(({ apply, yes, anilistToken, includeTextActivities }) =>
    Effect.gen(function* () {
      const token =
        (yield* Effect.tryPromise(() =>
          resolveAniListToken(Option.getOrUndefined(anilistToken)),
        )) ?? "";
      if (!token) {
        return yield* Effect.fail(
          new Error(
            "Missing AniList token: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.",
          ),
        );
      }
      // Scan phase runs to completion before the interactive confirm so the
      // readline prompt never fights the listr2 renderer for the screen.
      const scan: WipeCtx = yield* Effect.tryPromise({
        try: async () => {
          openFrame("anilist wipe manga");

          let viewerId: number | undefined;
          const run = createRun<WipeCtx>([
            {
              title: "AniList profile",
              task: async (_, task) => {
                makePhaseReporter(task).detail("Fetching your AniList profile…");
                const viewer = await fetchViewer(token);
                makePhaseReporter(task).note(`Signed in as ${viewer.name} (${viewer.id}).`);
                viewerId = viewer.id;
              },
            },
            {
              title: "Fetch manga list entries",
              task: async (ctx, _task) => {
                if (viewerId === undefined) {
                  throw new Error("Viewer lookup failed after AniList login.");
                }
                ctx.entries = await fetchMangaEntries(token, viewerId);
              },
            },
            {
              title: "Fetch manga-related activities",
              task: async (ctx, task) => {
                if (viewerId === undefined) {
                  throw new Error("Viewer lookup failed after AniList login.");
                }
                ctx.activities = await fetchMangaActivities(
                  token,
                  viewerId,
                  makePhaseReporter(task),
                  { includeTextActivities: includeTextActivities === true },
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
        catch: (cause) => new Error(errorMessage(cause)),
      });

      if (scan.entries.length === 0 && scan.activities.length === 0) {
        closeFrame("Nothing to delete.");
        return;
      }

      const textActivityCount = scan.activities.filter(
        (activity) => activity.type === "TEXT",
      ).length;

      if (!apply) {
        closeFrame(
          `Dry run: would delete ${scan.entries.length} list entries and ${scan.activities.length} activities${
            textActivityCount > 0 ? ` (including ${textActivityCount} text posts)` : ""
          }. Re-run with --apply.`,
        );
        return;
      }

      const confirmed = yes
        ? true
        : yield* Effect.tryPromise(() =>
            confirmInFrame(
              `This permanently wipes ${scan.entries.length} list entries and ${scan.activities.length} activities from the manga side of your AniList account${
                textActivityCount > 0
                  ? `, including ${textActivityCount} text posts (opted in via --include-text-activities)`
                  : " (text posts are excluded unless you pass --include-text-activities)"
              }. Continue?`,
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
              title: `Delete ${scan.activities.length} activities${
                textActivityCount > 0 ? ` (including ${textActivityCount} text posts)` : ""
              }`,
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
        catch: (cause) => new Error(errorMessage(cause)),
      });
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
