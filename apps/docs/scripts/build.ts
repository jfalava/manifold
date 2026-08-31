import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workingDirectory = process.cwd();
const root = existsSync(resolve(workingDirectory, "source"))
  ? workingDirectory
  : resolve(workingDirectory, "../..");
const docsDirectory = resolve(root, "apps/docs");

const run = (command: string, args: readonly string[], cwd: string): void => {
  const result = spawnSync(command, [...args], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("bun", ["x", "astro", "build"], docsDirectory);
