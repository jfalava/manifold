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
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";
import { AuthConnection } from "@manifold/contract";
import cliProgress from "cli-progress";

import { apiCall, apiConfig } from "@/commands/toolbox";
import { loadMalSession, saveMalSession } from "@/login/mal-session";
import { resolveValue } from "@/env-resolve";
import { createMalClient, wipeMalManga } from "@/mal";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";

export const wipeMalMangaCommand = Command.make("manga", {
  malToken: Flag.String("mal-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "Overrides keychain login. Prefer MANIFOLD_MAL_TOKEN to keep tokens out of shell history.",
    ),
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Delete all MAL manga list entries. Default is a read-only dry run; anime is never touched.",
    ),
  ),
  backupPaused: Flag.Boolean("backup-paused").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Acknowledge all other MAL writers are paused/disconnected. Required with --apply.",
    ),
  ),
  apiOrigin: Flag.String("api-origin").pipe(
    Flag.optional,
    Flag.withDescription(
      "Personal API origin for the backup-connection check. Falls back to MANIFOLD_API_ORIGIN.",
    ),
  ),
  apiToken: Flag.String("api-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "Personal API token for the backup-connection check. Falls back to MANIFOLD_TOKEN.",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Wipe MAL manga only, across every status, including adult entries. Does not read or modify AniList.",
  ),
  Command.withHandler(({ malToken, apply, backupPaused, apiOrigin, apiToken }) =>
    Effect.tryPromise({
      try: async () => {
        if (apply && !backupPaused) {
          throw new Error(
            "Pause/disconnect other MAL writers, then pass --backup-paused with --apply.",
          );
        }
        openFrame("mal wipe manga");
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
                "The Manifold API is still connected to MAL. Disconnect its MAL backup before wiping; --backup-paused does not override this check.",
              );
            }
            frameDetail(
              "Warning: Manifold's MAL backup is connected and can recreate entries. Disconnect it before --apply.",
            );
          }
        } else {
          frameDetail(
            "API backup connection not checked: MANIFOLD_TOKEN is unset. Verify other writers are paused yourself.",
          );
        }
        const accessToken = resolveValue(malToken, "MANIFOLD_MAL_TOKEN");
        const client = createMalClient({
          accessToken,
          session: accessToken ? undefined : await loadMalSession(),
          clientSecret: process.env.MANIFOLD_MAL_CLIENT_SECRET,
          saveSession: saveMalSession,
        });
        const progress = new cliProgress.SingleBar({
          stream: process.stdout,
          format:
            "│  {bar} {percentage}% · {value}/{total} manga · elapsed {duration_formatted} · ETA {eta_formatted}",
          barsize: 24,
          barCompleteChar: "█",
          barIncompleteChar: "░",
          hideCursor: true,
        });
        let progressStarted = false;
        const result = await wipeMalManga({
          client,
          apply,
          scanned: (account, entries) => {
            frameDetail(`Signed in as ${account}. Scanned ${entries.length} manga entries.`);
          },
          progress: (deleted, total) => {
            if (!progressStarted) {
              progress.start(total, deleted);
              progressStarted = true;
            } else {
              progress.update(deleted);
            }
          },
        }).finally(() => progress.stop());
        const account = `${result.account} (${result.accountId})`;
        if (!apply) {
          closeFrame(
            `Dry run: ${account}, ${result.scanned} manga entries would be deleted. No entries changed.`,
          );
        } else if (result.scanned === 0) {
          closeFrame(`${account}: manga list is already empty.`);
        } else {
          closeFrame(
            `${account}: deleted ${result.deleted} manga entries; verified empty. Anime untouched.`,
          );
        }
      },
      catch: (cause) => new Error(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
