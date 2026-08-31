import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";

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
  Flag.string(name).pipe(Flag.optional, Flag.withDescription(description));

export const al2mdCommand = Command.make(
  "migrate",
  {
    anilistToken: optional("anilist-token", "AniList access token. Falls back to ANILIST_TOKEN."),
    apply: Flag.boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Write statuses and read markers to MangaDex. Default is a dry run."),
    ),
    skipProgress: Flag.boolean("skip-progress").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Do not backfill chapter read markers."),
    ),
    mangadexClientId: optional("mangadex-client-id", "Falls back to MANGADEX_CLIENT_ID."),
    mangadexClientSecret: optional("mangadex-client-secret", "Falls back to MANGADEX_CLIENT_SECRET."),
    mangadexUsername: optional("mangadex-username", "Falls back to MANGADEX_USERNAME."),
    mangadexPassword: optional("mangadex-password", "Falls back to MANGADEX_PASSWORD."),
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
      // Lookup order per value: flag > bare env name > ALCHEMY_SECRET_ env
      // name (the iac/.env convention).
      const resolveValue = (
        flagValue: Option.Option<string>,
        ...names: readonly string[]
      ): string | undefined => {
        const direct = Option.getOrUndefined(flagValue);
        if (direct !== undefined) {return direct;}
        for (const name of names) {
          const value = process.env[name];
          if (value !== undefined && value !== "") {return value;}
        }
        return undefined;
      };

      const token =
        resolveValue(anilistToken, "ANILIST_TOKEN", "ALCHEMY_SECRET_ANILIST_TOKEN") ?? "";
      const credentials = {
        clientId:
          resolveValue(
            mangadexClientId,
            "MANGADEX_CLIENT_ID",
            "ALCHEMY_SECRET_MANGADEX_CLIENT_ID",
          ) ?? "",
        clientSecret:
          resolveValue(
            mangadexClientSecret,
            "MANGADEX_CLIENT_SECRET",
            "ALCHEMY_SECRET_MANGADEX_CLIENT_SECRET",
          ) ?? "",
        username:
          resolveValue(
            mangadexUsername,
            "MANGADEX_USERNAME",
            "ALCHEMY_SECRET_MANGADEX_USERNAME",
          ) ?? "",
        password:
          resolveValue(
            mangadexPassword,
            "MANGADEX_PASSWORD",
            "ALCHEMY_SECRET_MANGADEX_PASSWORD",
          ) ?? "",
      };

      if (!token) {
        return yield* Effect.fail(
          new Error(
            "Missing AniList token: pass --anilist-token or set ANILIST_TOKEN.\n" +
              "Create a client at https://anilist.co/settings/developer with\n" +
              'redirect URI "https://anilist.co/api/v2/oauth/pin", then open\n' +
              "https://anilist.co/api/v2/oauth/authorize?client_id=YOUR_ID&redirect_uri=https://anilist.co/api/v2/oauth/pin&response_type=token",
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
                makePhaseReporter(task).note(
                  `Fetched ${ctx.entries.length} AniList entries.`,
                );
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
                    : entry.mangadexStatus ?? "skipped";
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
                  makePhaseReporter(task).problem(
                    `${entry.title} — ${entry.reason}`,
                  );
                }

                if (
                  failures.length > 0 ||
                  migrationReport.unmatched.length > 0
                ) {
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
        catch: (cause) =>
          new Error(errorMessage(cause)),
      });
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
).pipe(
  Command.withDescription("Bring your MangaDex library up to parity with AniList (statuses + chapter markers)."),
  Command.withAlias("anilist-to-mangadex"),
);
