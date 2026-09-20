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
  // Tests are covered by vitest + tsc; oxlint tsgolint does not resolve
  // vitest aliases cleanly and floods no-unsafe-* noise (same as outfitting).
  ignorePatterns: [...agentIgnores, "*.d.ts", "**/*.d.ts", "dist/**", "test/**"],
  rules: {
    ...baseConfig.rules,
    ...antiSlopEffectRules,
  },
};
