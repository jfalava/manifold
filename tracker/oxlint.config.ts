import { defineConfig } from "oxlint";

import base, {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
} from "../oxlint.config.ts";

// Object spread instead of oxlint `extends`: extends-based inheritance drops
// env/globals/overrides from the parent config.
export default defineConfig({
  ...base,
  jsPlugins: antiSlopJsPlugins("..", { effect: true }),
  ignorePatterns: [
    ...agentIgnores,
    "*.d.ts",
    "**/*.d.ts",
    "bundles/**",
    "dist/**",
  ],
  rules: {
    ...base.rules,
    ...antiSlopEffectRules,
  },
});
