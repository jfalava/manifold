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

import { anilistLoginCommand } from "@/commands/login/anilist";
import { malLoginCommand } from "@/commands/login/mal";

/**
 * Top-level provider login: `manifold login anilist | mal`.
 * Keeps OAuth clients and keychain sessions local to the CLI.
 */
export const loginCommand = Command.make("login").pipe(
  Command.withDescription(
    "Authorize an upstream provider and store credentials in the OS keychain.",
  ),
  Command.withSubcommands([anilistLoginCommand, malLoginCommand]),
);
