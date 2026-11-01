/**
 * Write THIRD-PARTY-NOTICES.md for the compiled CLI: every npm package that
 * `bun build` bundles into index.ts, with its license text, plus a pointer to
 * the corresponding source of the release.
 *
 * Usage: bun scripts/third-party-notices.ts <outfile> [<source-url>]
 * Fails when a bundled package ships no license file, so a release never goes
 * out with a silently missing notice.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

const [outfile, sourceUrl = "https://github.com/jfalava/manifold"] = process.argv.slice(2);

if (outfile === undefined) {
  throw new Error("Usage: bun scripts/third-party-notices.ts <outfile> [<source-url>]");
}

const decodeMetafile = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ inputs: Schema.Record(Schema.String, Schema.Unknown) })),
);

const decodePackageJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      license: Schema.optional(Schema.String),
    }),
  ),
);

const workDir = mkdtempSync(join(tmpdir(), "manifold-notices-"));

try {
  const build = spawnSync(
    "bun",
    [
      "build",
      "index.ts",
      "--target=bun",
      "--outdir",
      workDir,
      `--metafile=${join(workDir, "meta.json")}`,
    ],
    { encoding: "utf8" },
  );

  if (build.status !== 0) {
    throw new Error(`bun build failed:\n${build.stderr}`);
  }

  const { inputs } = decodeMetafile(readFileSync(join(workDir, "meta.json"), "utf8"));
  const packageDirs = new Set<string>();

  for (const input of Object.keys(inputs)) {
    // The package root is the last node_modules/<name> or node_modules/@scope/<name> segment.
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);

    if (match?.[1] !== undefined) {
      packageDirs.add(resolve(match[1]));
    }
  }

  const sections = [...packageDirs]
    .map((dir) => {
      const pkg = decodePackageJson(readFileSync(join(dir, "package.json"), "utf8"));
      const licenseFile = readdirSync(dir).find((name) => /^(licen[cs]e|copying)/i.test(name));

      if (licenseFile === undefined) {
        throw new Error(`${pkg.name}@${pkg.version} is bundled but ships no license file.`);
      }

      const text = readFileSync(join(dir, licenseFile), "utf8").trim();

      return `## ${pkg.name}@${pkg.version} (${pkg.license ?? "see license text"})\n\n\`\`\`text\n${text}\n\`\`\``;
    })
    .sort((a, b) => a.localeCompare(b));

  writeFileSync(
    outfile,
    [
      "# Third-party notices",
      "",
      "This executable bundles Manifold-authored code (MIT, see LICENSE-MIT), code",
      "derived from Inkdex (GPL-3.0-or-later, see LICENSE and ATTRIBUTIONS.md), and the",
      "npm packages listed below. Because GPL-3.0-or-later code is included, the",
      "executable as a whole is conveyed under GPL-3.0-or-later.",
      "",
      `Corresponding source: ${sourceUrl}`,
      "",
      ...sections.flatMap((section) => [section, ""]),
    ].join("\n"),
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
