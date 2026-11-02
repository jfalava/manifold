/**
 * Fails when source silences a rule that must hold everywhere.
 *
 * Lint plugins can be switched off by the very comments they police, so this
 * runs as a plain text check over tracked files. It rejects disable comments
 * that name a strict rule (see `strictRules` in oxlint.config.ts) or name no
 * rule at all, and TypeScript's `@ts-ignore`, `@ts-nocheck` and
 * `@ts-expect-error`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { strictRules } from "../oxlint.config.ts";

const root = resolve(import.meta.dirname, "..");
const strict = new Set<string>(Object.keys(strictRules));
const DIRECTIVE = /(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|\*\/|$)(.*)$/;
const TS_SUPPRESSION = /@ts-(?:ignore|nocheck|expect-error)\b/;

const listed = spawnSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.astro"], {
  cwd: root,
  encoding: "utf8",
});

if (listed.status !== 0) {
  throw new Error(`git ls-files failed: ${listed.stderr}`);
}

// Vendored upstream code and generated files are not ours to edit.
const files = listed.stdout
  .split("\0")
  .filter(
    (file) =>
      file !== "" &&
      !file.startsWith("tools/oxlint/anti-slop/") &&
      !file.endsWith("routeTree.gen.ts"),
  );

const problems: string[] = [];

for (const file of files) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    const where = `${file}:${index + 1}`;
    const directive = DIRECTIVE.exec(line);

    if (directive) {
      const named = (directive[1] ?? "")
        .replace(/\*\/.*$/, "")
        .split("--")[0]
        ?.split(",")
        .map((rule) => rule.trim())
        .filter(Boolean);

      if (!named || named.length === 0) {
        problems.push(`${where}: disable comment must name the rules it disables`);
      }

      for (const rule of named ?? []) {
        if (strict.has(rule)) {
          problems.push(`${where}: ${rule} may not be disabled; fix the code instead`);
        }
      }
    }

    if (TS_SUPPRESSION.test(line)) {
      problems.push(`${where}: TypeScript suppressions are not allowed; fix the types instead`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} forbidden lint or type suppression(s).`);
  process.exit(1);
}

console.log(`Lint directives OK across ${files.length} files.`);
