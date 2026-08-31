#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliError, Command } from "effect/unstable/cli";

import { makeRootCommand } from "@/cli";
import { loadDotEnv } from "@/dotenv";

// Pick up repo secrets before handlers run: iac/.env holds the shared
// credentials; a local .env wins for anything it defines.
loadDotEnv(new URL("../../iac/.env", import.meta.url).pathname);
loadDotEnv(".env");

const program = Command.runWith(makeRootCommand(), {
  version: "0.1.0",
})(Bun.argv.slice(2)).pipe(
  Effect.provide(BunServices.layer),
  Effect.catch((error) =>
    Effect.sync(() => {
      process.exitCode = 1;
      if (!CliError.isCliError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
      }
    }),
  ),
  Effect.catchDefect((defect) =>
    Effect.sync(() => {
      process.exitCode = 1;
      const message = defect instanceof Error ? defect.message : String(defect);
      console.error(`Error: ${message}`);
    }),
  ),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
