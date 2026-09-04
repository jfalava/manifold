import { defineConfig } from "oxlint";

import {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
  baseConfig,
} from "../oxlint.config.ts";

// Object spread instead of oxlint `extends`: extends-based inheritance drops
// env/globals/overrides from the parent config.
export default defineConfig({
  ...baseConfig,
  jsPlugins: antiSlopJsPlugins("..", { effect: true }),
  ignorePatterns: [
    ...agentIgnores,
    "*.d.ts",
    "**/*.d.ts",
    "bundles/**",
    "dist/**",
  ],
  rules: {
    ...baseConfig.rules,
    ...antiSlopEffectRules,
    // Paperback extension console is the only on-device debug surface.
    "no-console": ["error", { allow: ["log", "warn", "error", "info"] }],
  },
});
