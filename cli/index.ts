#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { errorMessage } from "@manifold/json";
import { Effect } from "effect";
import { CliError, Command } from "effect/cli";

import { makeRootCommand } from "@/cli";
import { loadDotEnv } from "@/dotenv";
import { terminalSession, withTerminalSession } from "@/terminal-alert";
import { ui, writeOutput } from "@/ui";
import { finishProgress } from "@/ui/progress";
import { CLI_VERSION } from "@/version";

// Pick up CLI credentials from cli/.env (cwd or package-local path).
loadDotEnv(fileURLToPath(new URL("./.env", import.meta.url)));
loadDotEnv(".env");

const program = Command.runWith(makeRootCommand(CLI_VERSION), {
  version: CLI_VERSION,
})(Bun.argv.slice(2)).pipe(
  Effect.ensuring(Effect.sync(finishProgress)),
  Effect.provide(BunServices.layer),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      if (terminalSession()?.cancelled) {
        return yield* Effect.interrupt;
      }
      process.exitCode = 1;
      if (!CliError.isCliError(cause)) {
        writeOutput(`${ui.error(errorMessage(cause))}\n`, process.stderr);
      }
    }),
  ),
  Effect.catchDefect((cause) =>
    Effect.gen(function* () {
      if (terminalSession()?.cancelled) {
        return yield* Effect.interrupt;
      }
      process.exitCode = 1;
      writeOutput(`${ui.error(errorMessage(cause))}\n`, process.stderr);
    }),
  ),
  withTerminalSession,
);

BunRuntime.runMain(program, { disableErrorReporting: true });
