import { defineConfig } from "oxlint";

import {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
  baseConfig,
} from "../../oxlint.config.ts";

export default defineConfig({
  ...baseConfig,
  jsPlugins: antiSlopJsPlugins("../..", { effect: true }),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**"],
  rules: {
    ...baseConfig.rules,
    ...antiSlopEffectRules,
    // Paperback's JSCore console has log/warn/error, but no info method.
    "no-console": ["error", { allow: ["log", "warn", "error"] }],
  },
});
