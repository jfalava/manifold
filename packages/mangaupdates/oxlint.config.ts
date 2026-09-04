import { defineConfig } from "oxlint";

import {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
  baseConfig,
} from "../../oxlint.config.ts";

// Object spread instead of oxlint `extends`: extends-based inheritance drops
// env/globals/overrides from the parent config.
export default defineConfig({
  ...baseConfig,
  jsPlugins: antiSlopJsPlugins("../..", { effect: true }),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**"],
  rules: {
    ...baseConfig.rules,
    ...antiSlopEffectRules,
  },
});
