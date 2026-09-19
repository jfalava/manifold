/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const destination = resolve(import.meta.dirname, "../catalog-assets");
const legalFiles = ["LICENSE", "LICENSE-MIT", "ATTRIBUTIONS.md"] as const;

const plugins = [
  { packageName: "tracker", channel: "stable", id: "MANIFOLD" },
  { packageName: "tracker", channel: "beta", id: "MANIFOLD-beta" },
] as const;

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

for (const plugin of plugins) {
  const from = resolve(root, plugin.packageName, "bundles/production", plugin.id);
  const to = resolve(destination, plugin.channel, plugin.id);
  mkdirSync(resolve(destination, plugin.channel), { recursive: true });
  cpSync(from, to, { recursive: true });
  const bundledIcon = resolve(from, "static/icon.png");
  if (existsSync(bundledIcon)) {
    cpSync(bundledIcon, resolve(to, "icon.png"));
  }
}

for (const file of legalFiles) {
  cpSync(resolve(root, file), resolve(destination, file));
}
