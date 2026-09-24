/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalConsole:off */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveChannel } from "../api/scripts/channel.ts";

const root = resolve(import.meta.dirname, "..");
const channel = resolveChannel();

console.info(
  `[build-catalog] ENV=${channel.envValue} channel=${channel.channel} extensionId=${channel.extensionId}`,
);

const bundle = spawnSync("bun", ["run", "--cwd", "tracker", "bundle"], {
  cwd: root,
  env: {
    ...process.env,
    ENV: channel.envValue,
  },
  stdio: "inherit",
});

if (bundle.status !== 0) {
  process.exit(bundle.status === null ? 1 : bundle.status);
}

const stage = spawnSync("bun", ["api/scripts/stage-catalog.ts"], {
  cwd: root,
  env: {
    ...process.env,
    ENV: channel.envValue,
  },
  stdio: "inherit",
});

if (stage.status !== 0) {
  process.exit(stage.status === null ? 1 : stage.status);
}
