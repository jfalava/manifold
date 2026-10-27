/**
 * Export the self-signed codesigning identity from the login keychain as a
 * PKCS#12 bundle for reuse outside this machine (e.g. CI secrets).
 *
 *   bun run signing:export <output-dir>
 *
 * Writes <output-dir>/manifold-signing.p12, its base64 form (.p12.b64), and
 * an ephemeral password (.p12.pw) — all outside the repo (default: a temp
 * dir). Delete them after `gh secret set`. Rotate by re-provisioning
 * (`signing:provision`) then re-exporting.
 *
 * macOS will prompt "security wants to access key â¦/SimpleStep. â¦" â click
 * "Always Allow" so future exports don't prompt.
 */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalConsole:off */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CN = process.env.MANIFOLD_SIGN_CN ?? "Manifold Dev Signing";
const LOGIN_KEYCHAIN = process.env.HOME
  ? join(process.env.HOME, "Library", "Keychains", "login.keychain-db")
  : "login.keychain-db";

const outDir = process.argv[2] ? join(process.argv[2]) : mkdtempSync(join(tmpdir(), "manifold-signing-"));
const p12Path = join(outDir, "manifold-signing.p12");
const p64Path = join(outDir, "manifold-signing.p12.b64");
const pwPath = join(outDir, "manifold-signing.p12.pw");

const precheck = spawnSync(
  "security",
  ["find-certificate", "-c", CN, LOGIN_KEYCHAIN],
  { encoding: "utf8" },
);
if (!(precheck.status === 0)) {
  console.error(`[signing:export] "${CN}" not in login keychain. Provision first: bun run signing:provision`);
  process.exit(1);
}

const password = Array.from(
  crypto.getRandomValues(new Uint8Array(16)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");

// Legacy SHA-1/3DES params so the bundle is readable everywhere (same reason
// provisioning uses them — OpenSSL 4.x defaults are rejected by `security`).
const proc = spawnSync(
  "security",
  [
    "export",
    "-k",
    LOGIN_KEYCHAIN,
    "-t",
    "identities",
    "-f",
    "pkcs12",
    "-P",
    password,
    "-o",
    p12Path,
  ],
  { stdio: "inherit" },
);
if (proc.status !== 0) {
  console.error("[signing:export] security export failed");
  process.exit(proc.status === null ? 1 : proc.status);
}

writeFileSync(p64Path, readFileSync(p12Path).toString("base64"));
writeFileSync(pwPath, password);

console.info(`[signing:export] wrote ${p12Path}`);
console.info(`[signing:export] wrote ${p64Path} (base64, no line breaks)`);
console.info(`[signing:export] wrote ${pwPath} (ephemeral password)`);
console.info("[signing:export] next, upload as GitHub Actions secrets:");
console.info(`  gh secret set MANIFOLD_SIGNING_P12 < ${p64Path}`);
console.info(`  gh secret set MANIFOLD_SIGNING_P12_PASSWORD < ${pwPath}`);
console.info(`[signing:export] then delete ${outDir}`);
