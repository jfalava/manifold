import { Command } from "effect/unstable/cli";

import { anilistCommand } from "@/commands/anilist-auth";
import { al2mdCommand } from "@/commands/al2md";
import { al2Pas5Command } from "@/commands/al2pas5";
import { comixPrefillCommand } from "@/commands/comix-prefill";
import { mangadexPrefillCommand } from "@/commands/mangadex-prefill";
import { malCommand, wipeMalCommand } from "@/commands/mal";
import { importCommand, opsCommand, reconcileCommand } from "@/commands/toolbox";
import { md2alCommand } from "@/commands/md2al";
import { staleStatusCommand } from "@/commands/stale-status";
import { unfollowDroppedCommand } from "@/commands/unfollow-dropped";
import { wipeAlCommand } from "@/commands/wipe-al";

const migrateCommand = Command.make("migrate").pipe(
  Command.withDescription(
    "One-shot migrations and list maintenance for AniList, MangaDex, and MyAnimeList.",
  ),
  Command.withSubcommands([md2alCommand, al2mdCommand, wipeAlCommand, wipeMalCommand, al2Pas5Command]),
);

const reconcileGroup = Command.make("reconcile").pipe(
  Command.withDescription("Compare upstream state against the registry projection."),
  Command.withSubcommands([reconcileCommand]),
);

const registryCommand = Command.make("registry").pipe(
  Command.withDescription("Registry maintenance: backfill and inspect canonical rows."),
  Command.withSubcommands([importCommand, mangadexPrefillCommand, comixPrefillCommand]),
);

const mangadexCommand = Command.make("mangadex").pipe(
  Command.withDescription("MangaDex library maintenance (follow, reading status, etc.)."),
  Command.withSubcommands([unfollowDroppedCommand]),
);

export const makeRootCommand = () =>
  Command.make("manifold").pipe(
    Command.withDescription(
      "manifold CLI: migrations, op-log triage, drift reconciliation, and registry backfill.",
    ),
    Command.withSubcommands([
      migrateCommand,
      staleStatusCommand,
      unfollowDroppedCommand,
      mangadexCommand,
      malCommand,
      anilistCommand,
      opsCommand,
      reconcileGroup,
      registryCommand,
    ]),
  );
