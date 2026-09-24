/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { resolveChannel } from "./channel";

const root = resolve(import.meta.dirname, "../..");
const destination = resolve(import.meta.dirname, "../catalog-assets");
const legalFiles = ["LICENSE", "LICENSE-MIT", "ATTRIBUTIONS.md"] as const;

const channel = resolveChannel();
const plugin = {
  packageName: "tracker",
  channel: channel.channel,
  id: channel.extensionId,
} as const;

const channelRoot = resolve(destination, plugin.channel);
rmSync(channelRoot, { recursive: true, force: true });
mkdirSync(channelRoot, { recursive: true });
mkdirSync(destination, { recursive: true });

const from = resolve(root, plugin.packageName, "bundles/production", plugin.id);
if (!existsSync(from)) {
  throw new Error(
    `Missing bundled extension at ${from}. Run tracker bundle with ENV=${channel.envValue} first.`,
  );
}

const to = resolve(channelRoot, plugin.id);
cpSync(from, to, { recursive: true });
const bundledIcon = resolve(from, "static/icon.png");
if (existsSync(bundledIcon)) {
  cpSync(bundledIcon, resolve(to, "icon.png"));
}

for (const file of legalFiles) {
  cpSync(resolve(root, file), resolve(destination, file));
}

console.info(
  `[stage-catalog] staged ${plugin.id} → catalog-assets/${plugin.channel}/${plugin.id} (ENV=${channel.envValue})`,
);
