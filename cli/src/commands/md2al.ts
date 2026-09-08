import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";

import { resolveAniListToken } from "@/login/anilist";
import { createMangaDexTokenManager } from "@/mangadex-token";
import {
  abortFrame,
  closeFrame,
  createRun,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import {
  collectProgress,
  fetchExistingProgress,
  loadMatches,
  loadSnapshot,
  phaseExport,
  phaseMatch,
  saveMatches,
  type MatchResult,
  type MdLibraryEntry,
} from "@/md2al-core";

interface Md2alCtx extends RunContext {
  limited: MdLibraryEntry[];
  matches: MatchResult[];
  progressByMdId: Map<string, number>;
  existingProgress?: Map<string, number>;
}

export const md2alCommand = Command.make(
  "md2al",
  {
    anilistToken: Flag.string("anilist-token").pipe(
      Flag.optional,
      Flag.withDescription(
        "AniList access token override. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
      ),
    ),
    mangadexToken: Flag.string("mangadex-token").pipe(
      Flag.optional,
      Flag.withDescription(
        "MangaDex personal token with manga.read scope. Falls back to MANIFOLD_MANGADEX_TOKEN, or to the password-grant credentials below.",
      ),
    ),
    apply: Flag.boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Write entries to AniList. Default is a dry run."),
    ),
    skipProgress: Flag.boolean("skip-progress").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Do not push chapter progress from MD read markers."),
    ),
    useCache: Flag.boolean("use-cache").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Reuse cached snapshot, match results (including unmatched), and read-marker progress from .tmp instead of re-fetching.",
      ),
    ),
    limit: Flag.integer("limit").pipe(
      Flag.optional,
      Flag.withDescription(
        "Only process the first N entries after export. Handy for quick dry runs on big libraries.",
      ),
    ),
    phase: Flag.string("phase").pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Run a single phase: all | export | match | push."),
    ),
    mangadexClientId: Flag.string("mangadex-client-id").pipe(
      Flag.optional,
      Flag.withDescription("Falls back to MANIFOLD_MANGADEX_CLIENT_ID."),
    ),
    mangadexClientSecret: Flag.string("mangadex-client-secret").pipe(
      Flag.optional,
      Flag.withDescription("Falls back to MANIFOLD_MANGADEX_CLIENT_SECRET."),
    ),
    mangadexUsername: Flag.string("mangadex-username").pipe(
      Flag.optional,
      Flag.withDescription("Falls back to MANIFOLD_MANGADEX_USERNAME."),
    ),
    mangadexPassword: Flag.string("mangadex-password").pipe(
      Flag.optional,
      Flag.withDescription("Falls back to MANIFOLD_MANGADEX_PASSWORD."),
    ),
  },
  ({
    anilistToken,
    mangadexToken,
    apply,
    skipProgress,
    useCache,
    limit,
    phase,
    mangadexClientId,
    mangadexClientSecret,
    mangadexUsername,
    mangadexPassword,
  }) =>
    Effect.gen(function* () {
      const env = (key: string): string => process.env[key] ?? "";
      const flag = <A>(value: Option.Option<A>): A | undefined =>
        Option.getOrUndefined(value);

      const anilist = yield* Effect.tryPromise(() => resolveAniListToken(flag(anilistToken)));
      const credentials = {
        clientId: flag(mangadexClientId) || env("MANIFOLD_MANGADEX_CLIENT_ID"),
        clientSecret:
          flag(mangadexClientSecret) || env("MANIFOLD_MANGADEX_CLIENT_SECRET"),
        username: flag(mangadexUsername) || env("MANIFOLD_MANGADEX_USERNAME"),
        password: flag(mangadexPassword) || env("MANIFOLD_MANGADEX_PASSWORD"),
      };

      if (!anilist) {
        return yield* Effect.fail(
          new Error(
            "Missing AniList token: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.",
          ),
        );
      }

      let mdToken = flag(mangadexToken) || env("MANIFOLD_MANGADEX_TOKEN");
      let mdTokenManager: ReturnType<typeof createMangaDexTokenManager> | undefined;
      if (
        !mdToken &&
        credentials.clientId &&
        credentials.clientSecret &&
        credentials.username &&
        credentials.password
      ) {
        // Mint via the personal-client password grant and keep the manager
        // alive so long runs refresh before MD's ~15 min session expiry.
        mdTokenManager = createMangaDexTokenManager({ credentials });
        const manager = mdTokenManager;
        mdToken = yield* Effect.tryPromise({
          try: () => manager.current(),
          catch: (cause) =>
            new Error(
              `MangaDex token mint failed: ${errorMessage(cause)}`,
            ),
        });
      }
      if (!mdToken) {
        return yield* Effect.fail(
          new Error(
            "Missing MangaDex token: pass --mangadex-token, set MANIFOLD_MANGADEX_TOKEN, or provide the password-grant flags.",
          ),
        );
      }
      const getMdToken = async (): Promise<string> =>
        // SAFETY: value is a string after the preceding runtime check
        mdTokenManager ? mdTokenManager.current() : (mdToken as string);

      const tmpDir = ".tmp";

      yield* Effect.tryPromise({
        try: async () => {
          openFrame(`md2al ${apply ? "(apply)" : "(dry run)"}`);

          const run = createRun<Md2alCtx>([
            {
              title: "Export MangaDex library",
              task: async (ctx, task) => {
                if (phase === "all" || phase === "export") {
                  await phaseExport(getMdToken, tmpDir, makePhaseReporter(task));
                }
                const snapshot = loadSnapshot(tmpDir);
                if (!snapshot) {
                  throw new Error(
                    "No snapshot found. Run with --phase export first.",
                  );
                }
                const max = Option.getOrUndefined(limit);
                const limited =
                  max !== undefined && max > 0
                    ? snapshot.slice(0, max)
                    : snapshot;
                // Scope cached matches to the limited slice so --limit also
                // bounds the push phase.
                const limitedIds = new Set(
                  limited.map((entry) => entry.mangaDexId),
                );
                makePhaseReporter(task).detail(
                  `Processing ${limited.length} of ${snapshot.length} snapshot entries.`,
                );
                ctx.limited = limited;
                ctx.matches = [...loadMatches(tmpDir).values()].filter((m) =>
                  limitedIds.has(m.mangaDexId),
                );
              },
            },
            {
              title: "Match snapshot entries",
              skip: () => !(phase === "all" || phase === "match"),
              task: async (ctx, task) => {
                ctx.matches = await phaseMatch(
                  anilist,
                  ctx.limited,
                  tmpDir,
                  makePhaseReporter(task),
                  { useCache },
                );
              },
            },
            {
              title:
                "Push to AniList" +
                (apply ? "" : " (dry run)") +
                (skipProgress ? "" : " with chapter progress"),
              skip: () => !(phase === "all" || phase === "push"),
              task: async (ctx, task) => {
                if (
                  (phase === "match" || phase === "push") &&
                  ctx.matches.length === 0
                ) {
                  throw new Error(
                    "No match results found. Run with --phase match first.",
                  );
                }
                return task.newListr(
                  [
                    {
                      title: "Fetch existing AniList progress",
                      enabled: () => !skipProgress && apply,
                      task: async (subCtx, _subTask) => {
                        subCtx.existingProgress =
                          await fetchExistingProgress(anilist);
                      },
                    },
                    {
                      title: "Fetch MangaDex read markers",
                      enabled: () => !skipProgress,
                      task: async (subCtx, subTask) => {
                        const entryByMdId = new Map(
                          ctx.limited.map((e) => [e.mangaDexId, e]),
                        );
                        const markerEntries = ctx.matches.flatMap((m) => {
                          if (!m.anilistId) {return [];}
                          const e = entryByMdId.get(m.mangaDexId);
                          return e ? [e] : [];
                        });
                        subCtx.progressByMdId = await collectProgress(
                          getMdToken,
                          markerEntries,
                          makePhaseReporter(subTask),
                          { tmpDir, useCache },
                        );
                      },
                    },
                    {
                      title: apply ? "Save entries" : "Save entries (dry run)",
                      task: async (subCtx, subTask) => {
                        await saveMatches(
                          anilist,
                          ctx.matches,
                          subCtx.progressByMdId ?? new Map(),
                          subCtx.existingProgress,
                          { dryRun: !apply, progress: !skipProgress },
                          makePhaseReporter(subTask),
                        );
                      },
                    },
                  ],
                  { rendererOptions: { collapseSubtasks: false, indentation: 0 } },
                );
              },
            },
          ]);

          try {
            await run.run();
            closeFrame("Migration finished");
          } catch (error) {
            abortFrame();
            throw error;
          }
        },
        catch: (cause) => new Error(errorMessage(cause)),
      });
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
).pipe(
  Command.withDescription("Push your MangaDex library into AniList (private entries)."),
);
