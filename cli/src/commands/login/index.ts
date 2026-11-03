import { DateTime, Effect } from "effect";
import { Command } from "effect/cli";

import { anilistLoginCommand } from "@/commands/login/anilist";
import { malLoginCommand } from "@/commands/login/mal";
import { manifoldLoginCommand } from "@/commands/login/manifold";
import { fromPromise } from "@/effect-kit";
import { loadLoginStatus, type LoginStatus } from "@/login/status";
import { ui, writeOutput } from "@/ui";

const day = (at: number): string => DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 10);

const statusLine = ({ provider, label, state }: LoginStatus): string => {
  const name = label.padEnd(10);
  const relogin = `run manifold login ${provider}`;

  switch (state.kind) {
    case "env":
      return ui.note(`${name}${state.variable} from env (overrides the keychain login)`);
    case "missing":
      return ui.warning(`${name}not signed in · ${relogin}`);
    case "invalid":
      return ui.warning(`${name}unreadable keychain session · ${relogin}`);
    case "renews":
      return `  ${ui.success(`${name}signed in · renews on use`)}`;
    case "expires":
      return `  ${ui.success(`${name}signed in · expires ${day(state.at)}`)}`;
    case "expired":
      return ui.warning(`${name}expired ${day(state.at)} · ${relogin}`);
  }
};

/** Bare `manifold login` reports sign-in status; subcommands sign in. */
export const loginCommand = Command.make("login", {}, () =>
  fromPromise(() => loadLoginStatus()).pipe(
    Effect.map((statuses) => {
      writeOutput(`${statuses.map(statusLine).join("\n")}\n`);
      writeOutput(`  ${ui.muted("Sign in or renew: manifold login manifold|anilist|mal")}\n`);
    }),
  ),
).pipe(
  Command.withDescription("Show sign-in status, or sign in to Manifold, AniList or MAL."),
  Command.withSubcommands([manifoldLoginCommand, anilistLoginCommand, malLoginCommand]),
);
