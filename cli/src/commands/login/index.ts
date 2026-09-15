import { Command } from "effect/unstable/cli";

import { anilistLoginCommand } from "@/commands/login/anilist";
import { malLoginCommand } from "@/commands/login/mal";
import { manifoldLoginCommand } from "@/commands/login/manifold";

/**
 * Top-level provider login: `manifold login anilist | mal`.
 * Keeps OAuth clients and keychain sessions local to the CLI.
 */
export const loginCommand = Command.make("login").pipe(
  Command.withDescription(
    "Authorize Manifold or an upstream provider and store credentials in the OS keychain.",
  ),
  Command.withSubcommands([manifoldLoginCommand, anilistLoginCommand, malLoginCommand]),
);
