import { defineConfig } from "oxlint";

import base, {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
} from "../../oxlint.config.ts";

export default defineConfig({
  ...base,
  jsPlugins: antiSlopJsPlugins("../..", { effect: true }),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**"],
  rules: {
    ...base.rules,
    ...antiSlopEffectRules,
  },
});
