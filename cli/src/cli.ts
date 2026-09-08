import { Command } from "effect/unstable/cli";

import { anilistCommand } from "@/commands/anilist";
import { al2mdCommand } from "@/commands/al2md";
import { comixPrefillCommand } from "@/commands/comix-prefill";
import { loginCommand } from "@/commands/login";
import { malCommand } from "@/commands/mal";
import { mangadexCommand } from "@/commands/mangadex";
import { mangadexPrefillCommand } from "@/commands/mangadex-prefill";
import { importCommand, opsCommand, reconcileCommand } from "@/commands/toolbox";
import { al2malCommand } from "@/commands/al2mal";
import { md2alCommand } from "@/commands/md2al";

const migrateCommand = Command.make("migrate").pipe(
  Command.withDescription(
    "Cross-provider library migrations (AniList ↔ MangaDex, AniList → MAL).",
  ),
  Command.withSubcommands([md2alCommand, al2mdCommand, al2malCommand]),
);

const reconcileGroup = Command.make("reconcile").pipe(
  Command.withDescription("Compare upstream state against the registry projection."),
  Command.withSubcommands([reconcileCommand]),
);

const registryCommand = Command.make("registry").pipe(
  Command.withDescription("Registry maintenance: backfill and inspect canonical rows."),
  Command.withSubcommands([importCommand, mangadexPrefillCommand, comixPrefillCommand]),
);

export const makeRootCommand = () =>
  Command.make("manifold").pipe(
    Command.withDescription(
      "manifold CLI: provider ops, migrations, op-log triage, drift reconciliation, and registry backfill.",
    ),
    Command.withSubcommands([
      loginCommand,
      anilistCommand,
      mangadexCommand,
      malCommand,
      migrateCommand,
      opsCommand,
      reconcileGroup,
      registryCommand,
    ]),
  );
