import path from "path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const MOUNT_PATH = "/admin/";

export default defineConfig({
  base: MOUNT_PATH,
  server: { port: 5173, strictPort: false },
  plugins: [tailwindcss(), tanstackStart(), viteReact({ compiler: true })],
  optimizeDeps: {
    exclude: ["cloudflare:workers"],
  },
  build: {
    rolldownOptions: {
      external: ["cloudflare:workers"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
    tsconfigPaths: true,
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    insertFinalNewline: true,
    sortPackageJson: {
      sortScripts: true,
    },
    sortImports: {
      order: "asc",
      newlinesBetween: true,
      internalPattern: ["@/"],
      sortSideEffects: false,
      groups: [
        ["builtin"],
        ["external", "type-external"],
        ["internal", "type-internal"],
        ["parent", "type-parent"],
        ["sibling", "type-sibling"],
        ["index", "type-index"],
        ["unknown"],
      ],
    },
    sortTailwindcss: {
      stylesheet: "./src/styles/globals.css",
      attributes: ["class", "className"],
      functions: ["clsx", "cn", "cva", "twMerge"],
      preserveDuplicates: false,
      preserveWhitespace: false,
    },
    ignorePatterns: ["cloudflare-env.d.ts", "src/routeTree.gen.ts", "node_modules/**", "tools/**"],
  },
  lint: {
    plugins: ["eslint", "react", "typescript", "jsx-a11y", "unicorn", "oxc", "import", "promise"],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    env: {
      browser: true,
      ESNext: true,
    },
    ignorePatterns: ["*.d.ts", "**/*.d.ts", "public/**", "tools/**"],
    rules: {
      "typescript/no-explicit-any": "error",
      "no-underscore-dangle": [
        "error",
        {
          allow: ["_splat"],
        },
      ],
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
      "no-eval": "error",
      "no-debugger": "error",
      "no-console": [
        "error",
        {
          allow: ["warn", "error"],
        },
      ],
      "no-with": "error",
      "no-proto": "error",
      "no-new-wrappers": "error",
      "no-iterator": "error",
      "no-labels": "error",
      "no-var": "error",
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
      complexity: ["error", 25],
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-statements": ["error", 40],
      "import/no-duplicates": "error",
      "import/no-mutable-exports": "error",
      "import/no-cycle": "error",
      "import/no-self-import": "error",
      "react/jsx-key": "error",
      "react/jsx-no-undef": "error",
      "react/react-in-jsx-scope": "off",
      "react/no-direct-mutation-state": "error",
      "react/no-find-dom-node": "error",
      "react/no-danger": "error",
      "typescript/no-implied-eval": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unnecessary-type-assertion": "warn",
      // TanStack Table column defs pass cell renderers as config props.
      "react/no-unstable-nested-components": ["warn", { allowAsProps: true }],
      // Side-effect-only stylesheet imports are the standard Vite pattern.
      "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
