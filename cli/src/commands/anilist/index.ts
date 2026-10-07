import { Command } from "effect/cli";

import { wipeAlMangaCommand } from "@/commands/anilist/wipe-manga";

const wipeCommand = Command.make("wipe").pipe(
  Command.withDescription("Destructive AniList list maintenance (manga only)."),
  Command.withSubcommands([wipeAlMangaCommand]),
);

/**
 * Top-level AniList ops: `manifold anilist wipe manga`.
 * Auth stays under `manifold login anilist`.
 */
export const anilistCommand = Command.make("anilist").pipe(
  Command.withDescription("AniList list maintenance (auth via login anilist)."),
  Command.withSubcommands([wipeCommand]),
);
