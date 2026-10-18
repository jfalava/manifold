/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics schemaSync:off */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const mutatingCommands = [
  ["migrate", "mangadex-to-anilist"],
  ["migrate", "anilist-to-mangadex"],
  ["migrate", "anilist-to-mal"],
  ["anilist", "wipe", "manga"],
  ["mal", "wipe", "manga"],
  ["pas5", "create"],
  ["mangadex", "stale-status"],
  ["mangadex", "unfollow-dropped"],
  ["ops", "retry"],
  ["registry", "import"],
  ["registry", "mangadex"],
  ["registry", "kagane"],
] as const;

describe("remote mutation safeguards", () => {
  it("does not advertise retired registry commands or dedicated provider flags", () => {
    const help = (command: string[]) =>
      spawnSync("bun", ["index.ts", ...command, "--help"], {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
      });
    const registry = help(["registry"]);
    expect(registry.status).toBe(0);
    expect(registry.stdout).not.toContain("comix");
    const filter = help(["pas5", "filter"]);
    expect(filter.status).toBe(0);
    expect(filter.stdout).not.toContain("--exclude-comix");
    expect(filter.stdout).toContain("--exclude-source");
  });

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
