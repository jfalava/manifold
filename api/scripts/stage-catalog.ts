import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const destination = resolve(import.meta.dirname, "../catalog-assets");

const plugins = [{ packageName: "tracker", id: "MANIFOLD" }] as const;

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

for (const plugin of plugins) {
  const from = resolve(root, plugin.packageName, "bundles/production", plugin.id);
  const to = resolve(destination, plugin.id);
  cpSync(from, to, { recursive: true });
  const bundledIcon = resolve(from, "static/icon.png");
  if (existsSync(bundledIcon)) {
    cpSync(bundledIcon, resolve(to, "icon.png"));
  }
}
