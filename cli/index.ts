#!/usr/bin/env bun
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
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
    Effect.sync(() => {
      process.exitCode = 1;
      if (!CliError.isCliError(cause)) {
        const message = errorMessage(cause);
        console.error(`Error: ${message}`);
      }
    }),
  ),
  Effect.catchDefect((cause) =>
    Effect.sync(() => {
      process.exitCode = 1;
      const message = errorMessage(cause);
      console.error(`Error: ${message}`);
    }),
  ),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
