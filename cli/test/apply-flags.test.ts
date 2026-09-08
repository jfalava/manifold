import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const mutatingCommands = [
  ["migrate", "md2al"],
  ["migrate", "anilist-to-mangadex"],
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
