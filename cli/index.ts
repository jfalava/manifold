#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { errorMessage } from "@manifold/json";
import { Effect } from "effect";
import { CliError, Command } from "effect/unstable/cli";

import { makeRootCommand } from "@/cli";
import { loadDotEnv } from "@/dotenv";

// Pick up CLI credentials from cli/.env (cwd or package-local path).
loadDotEnv(new URL("./.env", import.meta.url).pathname);
loadDotEnv(".env");

const program = Command.runWith(makeRootCommand(), {
  version: "0.1.0",
})(Bun.argv.slice(2)).pipe(
  Effect.provide(BunServices.layer),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      process.exitCode = 1;
      if (!CliError.isCliError(cause)) {
        yield* Effect.logError(`Error: ${errorMessage(cause)}`);
      }
    }),
  ),
  Effect.catchDefect((cause) =>
    Effect.gen(function* () {
      process.exitCode = 1;
      yield* Effect.logError(`Error: ${errorMessage(cause)}`);
    }),
  ),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
