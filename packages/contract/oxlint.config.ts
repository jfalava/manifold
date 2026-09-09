import {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
  baseConfig,
} from "../../oxlint.config.ts";

export default {
  ...baseConfig,
  jsPlugins: antiSlopJsPlugins("../..", { effect: true }),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**"],
  rules: {
    ...baseConfig.rules,
    ...antiSlopEffectRules,
  },
};
