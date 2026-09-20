import { Command } from "effect/unstable/cli";

import { upgradeEffect } from "@/upgrade";

export const makeUpgradeCommand = (currentVersion: string) =>
  Command.make("upgrade", {}, () => upgradeEffect(currentVersion)).pipe(
    Command.withDescription(
      "Check for and install the latest manifold CLI release (compiled binary only).",
    ),
  );
