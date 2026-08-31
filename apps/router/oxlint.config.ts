import { defineConfig } from "oxlint";

import base, { agentIgnores, antiSlopJsPlugins } from "../../oxlint.config.ts";

// No direct `effect` dependency — generic anti-slop only.
export default defineConfig({
  ...base,
  jsPlugins: antiSlopJsPlugins("../.."),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**"],
});
