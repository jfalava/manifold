/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalFetch:off */
import { defineConfig } from "oxlint";

import { agentIgnores, antiSlopJsPlugins, baseConfig } from "../oxlint.config.ts";

// No direct `effect` dependency — generic anti-slop only.
export default defineConfig({
  ...baseConfig,
  jsPlugins: antiSlopJsPlugins(".."),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**"],
});
