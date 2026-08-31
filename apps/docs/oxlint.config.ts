import { defineConfig } from "oxlint";

import base, { agentIgnores, antiSlopJsPlugins } from "../../oxlint.config.ts";

// Object spread instead of oxlint `extends`: extends-based inheritance drops
// env/globals/overrides from the parent config.
// No direct `effect` dependency — generic anti-slop only.
export default defineConfig({
  ...base,
  jsPlugins: antiSlopJsPlugins("../.."),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**", ".astro/**"],
  env: { node: true, browser: true, es2022: true },
  globals: {
    ...base.globals,
    Astro: "readonly",
    Fragment: "readonly",
  },
});
