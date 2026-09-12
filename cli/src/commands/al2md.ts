/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";

import { ANILIST_REDIRECT_URI, resolveAniListToken } from "@/login/anilist";
import { fetchAniListMangaEntries, type AniListEntry } from "@/anilist";
import { runMigration } from "@/migration";
import { createMangaDexTokenManager } from "@/mangadex-token";
import {
  abortFrame,
  closeFrame,
  createRun,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";

interface Al2mdCtx extends RunContext {
  entries: readonly AniListEntry[];
}

const optional = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));

export const al2mdCommand = Command.make(
  "anilist-to-mangadex",
  {
    anilistToken: optional(
      "anilist-token",
      "AniList access token override. Prefer login anilist (keychain) or MANIFOLD_ANILIST_TOKEN.",
    ),
    apply: Flag.Boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Write statuses and read markers to MangaDex. Default is a dry run."),
    ),
    skipProgress: Flag.Boolean("skip-progress").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Do not backfill chapter read markers."),
    ),
    mangadexClientId: optional("mangadex-client-id", "Falls back to MANIFOLD_MANGADEX_CLIENT_ID."),
    mangadexClientSecret: optional(
      "mangadex-client-secret",
      "Falls back to MANIFOLD_MANGADEX_CLIENT_SECRET.",
    ),
    mangadexUsername: optional("mangadex-username", "Falls back to MANIFOLD_MANGADEX_USERNAME."),
    mangadexPassword: optional("mangadex-password", "Falls back to MANIFOLD_MANGADEX_PASSWORD."),
  },
  ({
    anilistToken,
    apply,
    skipProgress,
    mangadexClientId,
    mangadexClientSecret,
    mangadexUsername,
    mangadexPassword,
  }) =>
    Effect.gen(function* () {
      // Lookup order per value: flag > MANIFOLD_* env name.
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

      const token =
        (yield* Effect.tryPromise(() =>
          resolveAniListToken(Option.getOrUndefined(anilistToken)),
        )) ?? "";
      const credentials = {
        clientId: resolveValue(mangadexClientId, "MANIFOLD_MANGADEX_CLIENT_ID") ?? "",
        clientSecret: resolveValue(mangadexClientSecret, "MANIFOLD_MANGADEX_CLIENT_SECRET") ?? "",
        username: resolveValue(mangadexUsername, "MANIFOLD_MANGADEX_USERNAME") ?? "",
        password: resolveValue(mangadexPassword, "MANIFOLD_MANGADEX_PASSWORD") ?? "",
      };

      if (!token) {
        return yield* Effect.fail(
          new Error(
            "Missing AniList token: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.\n" +
              `Register ${ANILIST_REDIRECT_URI} on a separate authorization-code client, then run: bun index.ts login anilist`,
          ),
        );
      }
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

      yield* Effect.tryPromise({
        try: async () => {
          openFrame(`AniList → MangaDex ${apply ? "(apply)" : "(dry run)"}`);

          const run = createRun<Al2mdCtx>([
            {
              title: "Fetch AniList manga list",
              task: async (ctx, task) => {
                makePhaseReporter(task).detail("Fetching AniList manga list…");
                ctx.entries = await fetchAniListMangaEntries(token);
                makePhaseReporter(task).note(`Fetched ${ctx.entries.length} AniList entries.`);
              },
            },
            {
              title: "Sync to MangaDex",
              task: async (ctx, task) => {
                const entries = ctx.entries;
                const manager = createMangaDexTokenManager({ credentials });
                const migrationReport = await runMigration(entries, manager, {
                  dryRun: !apply,
                  includeProgress: !skipProgress,
                });

                const failures = migrationReport.matched.filter(
                  (entry) => entry.error !== undefined,
                );
                const chapters = migrationReport.matched.reduce(
                  (sum, entry) => sum + entry.chaptersToMark,
                  0,
                );

                makePhaseReporter(task).note(
                  `${migrationReport.dryRun ? "[dry run] " : ""}${migrationReport.scanned} scanned · ` +
                    `${migrationReport.matched.length} matched · ${migrationReport.unmatched.length} unmatched · ` +
                    `${chapters.toLocaleString()} chapters marked read`,
                );

                for (const entry of migrationReport.matched) {
                  const target = entry.mangaDexId || "(unresolved)";
                  const status = entry.error
                    ? `ERROR: ${entry.error}`
                    : (entry.mangadexStatus ?? "skipped");
                  const progress =
                    entry.progress !== undefined && entry.chaptersToMark > 0
                      ? `, ${entry.chaptersToMark} chapters`
                      : "";
                  makePhaseReporter(task).detail(
                    `${entry.title} → ${target} [${status}]` +
                      (entry.progress !== undefined
                        ? ` progress=${entry.progress}${progress}`
                        : ""),
                  );
                }
                for (const entry of migrationReport.unmatched) {
                  makePhaseReporter(task).problem(`${entry.title} — ${entry.reason}`);
                }

                if (failures.length > 0 || migrationReport.unmatched.length > 0) {
                  process.exitCode = 1;
                }
              },
              rendererOptions: { outputBar: Infinity, persistentOutput: true },
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
  Command.withDescription(
    "Bring your MangaDex library up to parity with AniList (statuses + chapter markers).",
  ),
);
