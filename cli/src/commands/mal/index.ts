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

import { wipeMalMangaCommand } from "@/commands/mal/wipe-manga";

const wipeCommand = Command.make("wipe").pipe(
  Command.withDescription("Destructive MAL list maintenance (manga only)."),
  Command.withSubcommands([wipeMalMangaCommand]),
);

/**
 * Top-level MAL ops: `manifold mal wipe manga`.
 * Auth stays under `manifold login mal`.
 */
export const malCommand = Command.make("mal").pipe(
  Command.withDescription("MyAnimeList list maintenance (auth via login mal)."),
  Command.withSubcommands([wipeCommand]),
);
