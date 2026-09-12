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
import { Command } from "effect/unstable/cli";

import { staleStatusCommand } from "@/commands/mangadex/stale-status";
import { unfollowDroppedCommand } from "@/commands/mangadex/unfollow-dropped";

/**
 * Top-level MangaDex library ops: `manifold mangadex stale-status | unfollow-dropped`.
 * Cross-provider list migrators stay under `migrate`.
 */
export const mangadexCommand = Command.make("mangadex").pipe(
  Command.withDescription(
    "MangaDex library maintenance (follow, reading status). Prefers MANIFOLD_MANGADEX_* credentials.",
  ),
  Command.withSubcommands([staleStatusCommand, unfollowDroppedCommand]),
);
