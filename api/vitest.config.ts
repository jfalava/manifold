import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Prefer source over stale `tsc` emit under dist/
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
