/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalConsole:off */
/**
 * Bundle tracker extensions for the active deploy channel.
 *
 * paperback-cli discovers every `src/<id>/{main,pbconfig}.ts` pair. Both
 * `MANIFOLD` and `MANIFOLD-beta` stay in source (beta reuses the stable
 * implementation). Staging (`stage-catalog.ts`) copies only the extension id
 * selected by `ENV` into `api/catalog-assets/<channel>/`.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveChannel } from "../api/scripts/channel.ts";

const trackerRoot = resolve(import.meta.dirname, "../tracker");
const channel = resolveChannel();
const debug = process.argv.includes("--debug");

console.info(
  `[bundle-tracker] ENV=${channel.envValue} will stage extensionId=${channel.extensionId}${debug ? " (debug)" : ""}`,
);

const args = ["paperback-cli", "bundle", "--folder", "production"];
if (debug) {
  args.push("--debug");
}

const result = spawnSync("bunx", args, {
  cwd: trackerRoot,
  env: {
    ...process.env,
    ENV: channel.envValue,
  },
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status === null ? 1 : result.status);
}
