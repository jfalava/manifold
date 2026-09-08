import { Command } from "effect/unstable/cli";

import { staleStatusCommand } from "@/commands/mangadex/stale-status";
import { unfollowDroppedCommand } from "@/commands/mangadex/unfollow-dropped";

/**
 * Top-level MangaDex library ops: `manifold mangadex stale-status | unfollow-dropped`.
 * Cross-provider list migrators stay under `migrate`.
 */
export const mangadexCommand = Command.make("mangadex").pipe(
  Command.withDescription(
    "MangaDex library maintenance (follow, reading status). Prefers MANIFOLD_MANGADEX_* credentials.",
  ),
  Command.withSubcommands([staleStatusCommand, unfollowDroppedCommand]),
);
