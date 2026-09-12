/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics schemaSync:off */
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
