/**
 * Compile the darwin-arm64 CLI binary, then codesign it with an identity
 * resolved from the macOS login keychain — no cert files on disk involved.
 *
 * Identity resolution for signing:
 *   1. $MANIFOLD_SIGN_IDENTITY, if set
 *   2. the first valid codesigning identity in the keychain, preferring a CN
 *      containing "Manifold"
 *   3. otherwise signing is skipped (exit 0) and the binary stays as-is
 *      (bun emits an ad-hoc signature) so cross-target `build:all` runs on
 *      non-mac hosts don't fail
 *
 * Provisioned once via `bun run signing:provision`.
 */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalConsole:off */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const OUTFILE = resolve("dist", "manifold-cli-darwin-arm64");

function findIdentity(): string | null {
  if (process.env.MANIFOLD_SIGN_IDENTITY) {
    return process.env.MANIFOLD_SIGN_IDENTITY;
  }
  if (process.platform !== "darwin") {
    return null;
  }
  const probe = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  const candidates = (probe.stdout ?? "")
    .split("\n")
    .map((line) => line.match(/^\s*\d+\)\s+[0-9a-fA-F]+\s+"(.+)"$/)?.[1])
    .filter((name): name is string => name !== undefined);
  return candidates.find((name) => /manifold/i.test(name)) ?? candidates[0] ?? null;
}

function run(name: string, args: string[], label: string): number {
  const proc = spawnSync(name, args, { stdio: "inherit" });
  if (proc.status !== 0) {
    console.error(
      `[build:darwin-arm64] ${label} failed. If the keychain is locked run \`security unlock-keychain\`, and if codesign asks for key access click Always Allow. Provision an identity with \`bun run signing:provision\`.`,
    );
    process.exit(proc.status === null ? 1 : proc.status);
  }
  return proc.status;
}

mkdirSync("dist", { recursive: true });
run(
  "bun",
  ["build", "--compile", "--target=bun-darwin-arm64", "index.ts", "--outfile", OUTFILE],
  "bun build --compile",
);
console.info(`[build:darwin-arm64] compiled ${OUTFILE}`);

const identity = findIdentity();
if (!identity) {
  if (process.platform !== "darwin") {
    console.info(`[build:darwin-arm64] skipping codesign on ${process.platform}`);
  } else {
    console.info(
      "[build:darwin-arm64] no codesigning identity in keychain; skipping sign. Provision one with `bun run signing:provision`.",
    );
  }
  process.exit(0);
}

console.info(`[build:darwin-arm64] signing with identity "${identity}"`);
run("codesign", ["--force", "--timestamp", "--sign", identity, OUTFILE], "codesign sign");
run("codesign", ["--verify", "--strict", OUTFILE], "codesign verify");
run("codesign", ["-dv", OUTFILE], "codesign info");
