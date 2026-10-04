import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDotEnv } from "../src/dotenv";

const loadedKeys: string[] = [];

afterEach(() => {
  for (const key of loadedKeys.splice(0)) {
    delete process.env[key];
  }
});

describe("loadDotEnv", () => {
  it("keeps comments out of quoted values and preserves hashes inside quotes", () => {
    const directory = mkdtempSync(join(tmpdir(), "manifold-dotenv-"));
    const file = join(directory, ".env");
    const keys = ["MANIFOLD_TEST_QUOTED", "MANIFOLD_TEST_HASH"];
    loadedKeys.push(...keys);
    try {
      writeFileSync(file, 'MANIFOLD_TEST_QUOTED="value" # comment\nMANIFOLD_TEST_HASH="a # b"\n');
      loadDotEnv(file);
      expect(process.env.MANIFOLD_TEST_QUOTED).toBe("value");
      expect(process.env.MANIFOLD_TEST_HASH).toBe("a # b");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
