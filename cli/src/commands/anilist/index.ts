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
