import {
  agentIgnores,
  antiSlopEffectRules,
  antiSlopJsPlugins,
  baseConfig,
} from "../oxlint.config.ts";

// Object spread instead of oxlint `extends`: extends-based inheritance drops
// env/globals/overrides from the parent config.
export default {
  ...baseConfig,
  jsPlugins: antiSlopJsPlugins("..", { effect: true }),
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "catalog-assets/**", "dist/**"],
  rules: {
    ...baseConfig.rules,
    ...antiSlopEffectRules,
  },
};
