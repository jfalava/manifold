import { defineConfig, type DummyRuleMap } from "oxlint";

// Oxlint rejects relative jsPlugins specifiers inside configs consumed via
// `extends`, so the base exposes a factory and each workspace registers the
// plugins itself with a path prefix relative to its own directory
// (".." for workspace roots, "../.." for apps/* and packages/*).
//
// Effect plugin is opt-in: only packages with a direct `effect` dependency
// should pass `{ effect: true }` (skill: install-anti-slop).
export const antiSlopJsPlugins = (
  specifierPrefix: string,
  options: { effect?: boolean } = {},
) => {
  const plugins = [
    {
      name: "anti-slop",
      specifier: `${specifierPrefix}/tools/oxlint/anti-slop/index.ts`,
    },
  ];
  if (options.effect) {
    plugins.push({
      name: "anti-slop-effect",
      specifier: `${specifierPrefix}/tools/oxlint/anti-slop/effect/index.ts`,
    });
  }
  return plugins;
};

// Agent-tool directories can appear anywhere; never lint them as source.
// Patterns resolve relative to each consuming config's directory.
// Note: oxlint rejects `..` in ignorePatterns, so monorepo packages cannot
// ignore the root-vendored plugin path from a nested config.
export const agentIgnores = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
];

// Boundary anti-slop rules that require monorepo-wide parse-at-I/O redesign stay
// "warn" (typeof, unknown-params, unsafe-dictionary). Everything else is "error"
// (memory 1014: anti-slop warn→error).
export const antiSlopRules: DummyRuleMap = {
  "anti-slop/no-chained-type-assertions": "error",
  "anti-slop/no-conditional-empty-object-spread": "error",
  "anti-slop/no-known-value-widening": "error",
  "anti-slop/no-module-mocking": "error",
  "anti-slop/no-object-parameters": "error",
  "anti-slop/no-reflect-apply": "error",
  "anti-slop/no-reflect-get": "error",
  "anti-slop/no-runtime-typeof": "warn",
  "anti-slop/no-shape-in-symbol-names": "error",
  "anti-slop/no-unknown-parameters": "warn",
  "anti-slop/no-unknown-returns": "error",
  "anti-slop/no-unknown-type-aliases": "error",
  "anti-slop/no-unsafe-dictionary-type": "warn",
  "anti-slop/no-widen-then-assert": "error",
  "anti-slop/require-safety-comment-for-type-assertion": "error",
};

export const antiSlopEffectRules: DummyRuleMap = {
  "anti-slop-effect/no-service-constructor-imports": "error",
};

/** Generic + Effect anti-slop rules for packages that depend on `effect`. */
export const antiSlopRulesWithEffect: DummyRuleMap = {
  ...antiSlopRules,
  ...antiSlopEffectRules,
};

const builtinRules: DummyRuleMap = {
  "typescript/no-explicit-any": "error",
  "typescript/no-unsafe-assignment": "error",
  "typescript/no-unsafe-call": "error",
  "typescript/no-unsafe-member-access": "error",
  "typescript/no-unsafe-return": "error",
  "no-unused-vars": [
    "error",
    {
      vars: "all",
      args: "after-used",
      caughtErrors: "all",
      ignoreRestSiblings: false,
      varsIgnorePattern: "^_",
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "no-undef": "error",
  "no-unreachable": "error",
  "no-dupe-keys": "error",
  "no-dupe-class-members": "error",
  "no-fallthrough": "error",
  "no-duplicate-imports": "error",
  "no-implied-eval": "error",
  "no-eval": "error",
  "no-debugger": "error",
  "no-console": [
    "error",
    {
      allow: ["warn", "error", "info"],
    },
  ],
  "no-with": "error",
  "no-proto": "error",
  "no-new-wrappers": "error",
  "no-iterator": "error",
  "no-labels": "error",
  "no-var": "error",
  "no-shadow": [
    "error",
    {
      hoist: "functions",
      builtinGlobals: true,
    },
  ],
  "no-param-reassign": "error",
  "no-extend-native": "error",
  "no-func-assign": "error",
  "no-empty-function": "error",
  "no-extra-bind": "error",
  "no-useless-constructor": "error",
  "no-unused-expressions": "error",
  eqeqeq: [
    "error",
    "always",
    {
      null: "ignore",
    },
  ],
  curly: ["error", "all"],
  "no-implicit-coercion": [
    "error",
    {
      boolean: true,
      number: true,
      string: true,
      disallowTemplateShorthand: true,
    },
  ],
  "prefer-const": [
    "error",
    {
      destructuring: "all",
    },
  ],
  "prefer-arrow-callback": "error",
  // First-enable calibration: existing entrypoints (api handle, cli migrators)
  // exceed tBC's 40/80. Tighten after the split pass (memory: lint complexity debt).
  complexity: ["error", 200],
  "max-depth": ["error", 8],
  "max-params": ["error", 6],
  "max-statements": ["error", 200],
  "import/no-duplicates": "error",
  "import/no-mutable-exports": "error",
};

// Strict application base: type-aware linting over the built-in plugins plus
// the vendored anti-slop rules. Workspace configs spread this and add their
// own jsPlugins registration and ignorePatterns.
export default defineConfig({
  options: {
    typeAware: true,
    typeCheck: true,
  },
  plugins: ["eslint", "react", "typescript", "unicorn", "oxc", "import", "promise"],
  env: {
    node: true,
    browser: false,
    es2022: true,
  },
  globals: {
    Bun: "readonly",
    // Paperback extension runtime injects Application; source/tracker/paperback-*
    // packages call it as a free global (see @paperback/types).
    Application: "readonly",
  },
  overrides: [
    {
      files: ["*.test.ts", "**/*.test.ts"],
      rules: {
        "no-shadow": "off",
      },
    },
  ],
  rules: {
    ...builtinRules,
    ...antiSlopRules,
  },
});
