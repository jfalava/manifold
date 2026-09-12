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
