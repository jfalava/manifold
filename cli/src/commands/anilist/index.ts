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

import { createPas5Command } from "@/commands/anilist/create-pas5";
import { wipeAlMangaCommand } from "@/commands/anilist/wipe-manga";

const createCommand = Command.make("create").pipe(
  Command.withDescription("Build artifacts from the signed-in AniList manga list."),
  Command.withSubcommands([createPas5Command]),
);

const wipeCommand = Command.make("wipe").pipe(
  Command.withDescription("Destructive AniList list maintenance (manga only)."),
  Command.withSubcommands([wipeAlMangaCommand]),
);

/**
 * Top-level AniList ops: `manifold anilist create pas5 | wipe manga`.
 * Auth stays under `manifold login anilist`.
 */
export const anilistCommand = Command.make("anilist").pipe(
  Command.withDescription("AniList list maintenance and export (auth via login anilist)."),
  Command.withSubcommands([createCommand, wipeCommand]),
);
