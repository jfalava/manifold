import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { ListrTask } from "listr2";
import { errorMessage, isJsonObject, manifoldUserAgent, numberField } from "@manifold/json";

import { createMangaDexTokenManager } from "@/mangadex-token";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import {
  createMangaDexClient,
  MANGADEX_CONTENT_RATINGS,
  type MangaDexReadingStatus,
} from "@manifold/mangadex";

interface UnfollowCtx extends RunContext {
  droppedIds: readonly string[];
  followedDroppedIds: readonly string[];
  titles: Readonly<Record<string, string>>;
}

const READ_SPACING_MS = 250;
const WRITE_SPACING_MS = 220;
const TITLE_BATCH_SIZE = 100;
const DETAIL_LINE_CAP = 40;
const TOKEN_CACHE_PATH = ".tmp/mangadex-token.json";

const VALID_STATUSES: readonly MangaDexReadingStatus[] = [
  "reading",
  "on_hold",
  "plan_to_read",
  "dropped",
  "re_reading",
  "completed",
];

const optional = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));

const parseList = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    mangadexClientId: optional("mangadex-client-id", "Falls back to MANIFOLD_MANGADEX_CLIENT_ID."),
    mangadexClientSecret: optional(
      "mangadex-client-secret",
      "Falls back to MANIFOLD_MANGADEX_CLIENT_SECRET.",
    ),
    mangadexUsername: optional("mangadex-username", "Falls back to MANIFOLD_MANGADEX_USERNAME."),
    mangadexPassword: optional("mangadex-password", "Falls back to MANIFOLD_MANGADEX_PASSWORD."),
  },
  ({ status, apply, mangadexClientId, mangadexClientSecret, mangadexUsername, mangadexPassword }) =>
    Effect.gen(function* () {
      const resolveValue = (
        flagValue: Option.Option<string>,
        ...names: readonly string[]
      ): string | undefined => {
        const direct = Option.getOrUndefined(flagValue);
        if (direct !== undefined) {
          return direct;
        }
        for (const name of names) {
          const value = process.env[name];
          if (value !== undefined && value !== "") {
            return value;
          }
        }
        return undefined;
      };

      const credentials = {
        clientId: resolveValue(mangadexClientId, "MANIFOLD_MANGADEX_CLIENT_ID") ?? "",
        clientSecret: resolveValue(mangadexClientSecret, "MANIFOLD_MANGADEX_CLIENT_SECRET") ?? "",
        username: resolveValue(mangadexUsername, "MANIFOLD_MANGADEX_USERNAME") ?? "",
        password: resolveValue(mangadexPassword, "MANIFOLD_MANGADEX_PASSWORD") ?? "",
      };
      const missing = Object.entries(credentials)
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Missing MangaDex credentials: ${missing.join(", ")}. Pass them as flags or set MANGADEX_*.`,
          ),
        );
      }

      const targetStatuses = parseList(status);
      const invalid = targetStatuses.filter(
        // SAFETY: value matches MangaDexReadingStatus at this call site
        (s) => !VALID_STATUSES.includes(s as MangaDexReadingStatus),
      );
      if (invalid.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Invalid --status values: ${invalid.join(", ")}. Choose from: ${VALID_STATUSES.join(", ")}.`,
          ),
        );
      }
      if (targetStatuses.length === 0) {
        return yield* Effect.fail(new Error("--status cannot be empty."));
      }

      yield* Effect.tryPromise({
        try: async () => {
          openFrame(
            `Unfollow dropped → ${targetStatuses.join(",")} ${apply ? "(apply)" : "(dry run)"}`,
          );

          const manager = createMangaDexTokenManager({
            credentials,
            cachePath: TOKEN_CACHE_PATH,
          });
          let client = createMangaDexClient({
            accessToken: await manager.current(),
            userAgent: manifoldUserAgent("cli"),
          });
          const refreshClient = async () => {
            client = createMangaDexClient({
              accessToken: await manager.current(),
              userAgent: manifoldUserAgent("cli"),
            });
            return client;
          };

          const fetchStatusesTask: ListrTask<UnfollowCtx> = {
            title: "Fetch reading statuses",
            task: async (ctx, task) => {
              const statuses = await Effect.runPromise(client.readingStatuses());
              const droppedIds = Object.entries(statuses)
                .filter(([, s]) => targetStatuses.includes(s))
                .map(([id]) => id);
              ctx.droppedIds = droppedIds;
              makePhaseReporter(task).note(
                `❖ ${Object.keys(statuses).length} library entries · ${droppedIds.length} with status ${targetStatuses.join(", ")}.`,
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
              const followed = new Set<string>();
              let offset = 0;
              while (true) {
                const page = await Effect.runPromise(client.followedManga({ limit: 100, offset }));
                for (const manga of page.items) {
                  followed.add(manga.id);
                }
                offset += page.items.length;
                const total = page.total ?? offset;
                reporter.progress(followed.size, total, [["followed", followed.size]] as const);
                if (page.items.length === 0 || offset >= total) {
                  break;
                }
                await sleep(READ_SPACING_MS);
              }
              const followedDroppedIds = ctx.droppedIds.filter((id) => followed.has(id));
              ctx.followedDroppedIds = followedDroppedIds;
              reporter.note(
                `❖ ${followedDroppedIds.length} followed of ${ctx.droppedIds.length} ${targetStatuses.join(", ")} entries.` +
                  (followedDroppedIds.length === 0 ? " Nothing to unfollow." : ""),
              );

              if (followedDroppedIds.length === 0) {
                ctx.titles = {};
                return;
              }
              const titles: Record<string, string> = {};
              for (let start = 0; start < followedDroppedIds.length; start += TITLE_BATCH_SIZE) {
                const batch = followedDroppedIds.slice(start, start + TITLE_BATCH_SIZE);
                const page = await Effect.runPromise(
                  client.listManga({
                    ids: batch,
                    contentRating: [...MANGADEX_CONTENT_RATINGS],
                    limit: 100,
                  }),
                );
                for (const manga of page.items) {
                  titles[manga.id] = manga.title;
                }
                await sleep(READ_SPACING_MS);
              }
              ctx.titles = titles;
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
                      await refreshClient();
                      const failures: string[] = [];
                      let done = 0;
                      for (const mangaId of ctx.followedDroppedIds) {
                        try {
                          await Effect.runPromise(client.unfollowManga(mangaId));
                        } catch (cause) {
                          const msg = errorMessage(cause);
                          const isAuth =
                            isJsonObject(cause) && numberField(cause, "status") === 401;
                          if (isAuth) {
                            try {
                              await refreshClient();
                              await Effect.runPromise(client.unfollowManga(mangaId));
                              done += 1;
                              reporter.progress(done, ctx.followedDroppedIds.length, [
                                ["failed", failures.length],
                              ] as const);
                              if (done < ctx.followedDroppedIds.length) {
                                await sleep(WRITE_SPACING_MS);
                              }
                              continue;
                            } catch (retryCause) {
                              failures.push(
                                `${ctx.titles[mangaId] ?? mangaId}: ${errorMessage(retryCause)}`,
                              );
                            }
                          } else {
                            failures.push(`${ctx.titles[mangaId] ?? mangaId}: ${msg}`);
                          }
                        }
                        done += 1;
                        reporter.progress(done, ctx.followedDroppedIds.length, [
                          ["failed", failures.length],
                        ] as const);
                        frameDetail(`  ${ctx.titles[mangaId] ?? mangaId} unfollowed`);
                        if (done < ctx.followedDroppedIds.length) {
                          await sleep(WRITE_SPACING_MS);
                        }
                      }
                      for (const failure of failures.slice(0, DETAIL_LINE_CAP)) {
                        reporter.problem(failure);
                      }
                      if (failures.length > DETAIL_LINE_CAP) {
                        reporter.problem(`…and ${failures.length - DETAIL_LINE_CAP} more failures`);
                      }
                      reporter.note(`❖ ${done - failures.length}/${done} unfollowed.`);
                      if (failures.length > 0) {
                        process.exitCode = 1;
                      }
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
                        reporter.detail(`❖ ${ctx.titles[mangaId] ?? "(untitled)"} [${mangaId}]`);
                      }
                      if (ctx.followedDroppedIds.length > DETAIL_LINE_CAP) {
                        reporter.detail(
                          `❖ …and ${ctx.followedDroppedIds.length - DETAIL_LINE_CAP} more`,
                        );
                      }
                      reporter.note(
                        `❖ Dry run: would unfollow ${ctx.followedDroppedIds.length} entries (${targetStatuses.join(", ")}). Re-run with --apply.`,
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
        catch: (cause) => new Error(errorMessage(cause)),
      }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
    }),
).pipe(
  Command.withDescription(
    "Uncheck the Follow box on MangaDex entries with a given reading status (default: dropped).",
  ),
);
