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
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const mutatingCommands = [
  ["migrate", "mangadex-to-anilist"],
  ["migrate", "anilist-to-mangadex"],
  ["migrate", "anilist-to-mal"],
  ["anilist", "wipe", "manga"],
  ["mal", "wipe", "manga"],
  ["anilist", "create", "pas5"],
  ["mangadex", "stale-status"],
  ["mangadex", "unfollow-dropped"],
  ["ops", "retry"],
  ["registry", "import"],
  ["registry", "mangadex"],
  ["registry", "comix"],
] as const;

describe("remote mutation safeguards", () => {
  for (const command of mutatingCommands) {
    it(`${command.join(" ")} exposes --apply`, () => {
      const result = spawnSync("bun", ["index.ts", ...command, "--help"], {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--apply");
    });
  }
});
