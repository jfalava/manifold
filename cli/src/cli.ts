import { Command } from "effect/cli";

import { anilistCommand } from "@/commands/anilist";
import { al2mdCommand } from "@/commands/al2md";
import { debugCommand } from "@/commands/debug";
import { kaganePrefillCommand } from "@/commands/kagane-prefill";
import { loginCommand } from "@/commands/login";
import { malCommand } from "@/commands/mal";
import { malPrefillCommand } from "@/commands/mal-prefill";
import { mangadexCommand } from "@/commands/mangadex";
import { mangadexPrefillCommand } from "@/commands/mangadex-prefill";
import { manganatoPrefillCommand } from "@/commands/manganato-prefill";
import { xcomicPrefillCommand } from "@/commands/xcomic-prefill";
import { importCommand, opsCommand, reconcileCommand } from "@/commands/toolbox";
import { al2malCommand } from "@/commands/al2mal";
import { md2alCommand } from "@/commands/md2al";
import { makeUpgradeCommand } from "@/commands/upgrade";
import { pas5Command } from "@/commands/pas5";
import { pas5ImportCommand } from "@/commands/pas5-import";

const migrateCommand = Command.make("migrate").pipe(
  Command.withDescription("Cross-provider library migrations (AniList ↔ MangaDex, AniList → MAL)."),
  Command.withSubcommands([md2alCommand, al2mdCommand, al2malCommand]),
);

const reconcileGroup = Command.make("reconcile").pipe(
  Command.withDescription("Compare upstream state against the registry projection."),
  Command.withSubcommands([reconcileCommand]),
);

const registryCommand = Command.make("registry").pipe(
  Command.withDescription("Registry maintenance: backfill and inspect canonical rows."),
  Command.withSubcommands([
    importCommand,
    pas5ImportCommand,
    malPrefillCommand,
    mangadexPrefillCommand,
    kaganePrefillCommand,
    manganatoPrefillCommand,
    xcomicPrefillCommand,
  ]),
);

export const makeRootCommand = (version: string) =>
  Command.make("manifold").pipe(
    Command.withDescription(
      "manifold CLI: provider ops, migrations, op-log triage, drift reconciliation, and registry backfill.",
    ),
    Command.withSubcommands([
      loginCommand,
      pas5Command,
      anilistCommand,
      mangadexCommand,
      malCommand,
      migrateCommand,
      opsCommand,
      reconcileGroup,
      registryCommand,
      makeUpgradeCommand(version),
      debugCommand,
    ]),
  );
