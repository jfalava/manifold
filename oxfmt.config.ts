import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  endOfLine: "lf" as const,
  semi: true,
  singleQuote: false,
  trailingComma: "all" as const,
  insertFinalNewline: true,
  experimentalSortPackageJson: {
    sortScripts: true,
  },
  sharedSortImportsBase: {
    order: "asc" as const,
    newlinesBetween: true,
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
  attributes: ["class", "className"],
  functions: ["cn", "cva"],
  preserveDuplicates: false,
  preserveWhitespace: false,
});
