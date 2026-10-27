/**
 * One-time provisioning of a self-signed codesigning certificate.
 *
 * Generates an RSA-2048 certificate with the Code Signing EKU, imports it
 * into the macOS login keychain (allowing /usr/bin/codesign to use it), and
 * marks it trusted for Code Signing. The on-disk PEM/PKCS#12 files are
 * deleted after import — the keychain is the only remaining copy.
 *
 *   bun run signing:provision
 *
 * Environment:
 *   MANIFOLD_SIGN_CN  certificate common name (default "Manifold Dev Signing")
 *
 * Notes:
 *   - `security add-trusted-cert` may pop a dialog asking for the keychain
 *     password; click "Confirm" to add the user-domain trust setting.
 *   - The first `codesign` run may prompt "codesign wants to access the key";
 *     click "Always Allow".
 */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalConsole:off */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CN = process.env.MANIFOLD_SIGN_CN ?? "Manifold Dev Signing";
const LOGIN_KEYCHAIN = process.env.HOME
  ? join(process.env.HOME, "Library", "Keychains", "login.keychain-db")
  : "login.keychain-db";

// find-identity alone can't detect an imported-but-not-yet-trusted cert here,
// so probe by name at the certificate level instead.
const probe = spawnSync(
  "security",
  ["find-certificate", "-c", CN, LOGIN_KEYCHAIN],
  { encoding: "utf8" },
);
if (probe.status === 0 && !probe.stderr?.includes("could not be found")) {
  console.error(
    `[signing:provision] keychain already contains "${CN}". Remove it in Keychain Access (login keychain > My Certificates) or set MANIFOLD_SIGN_CN to a different name.`,
  );
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "manifold-signing-"));
const keyPath = join(dir, "key.pem");
const certPath = join(dir, "cert.pem");
const p12Path = join(dir, "bundle.p12");

// Ephemeral password for the PKCS#12 export; only used on disk within this run.
const password = Array.from(
  crypto.getRandomValues(new Uint8Array(16)),
  (b) => b.toString(16).padStart(2, "0"),
).join("");

const opensslConfig = join(dir, "openssl.cnf");
writeFileSync(
  opensslConfig,
  [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "x509_extensions = v3_code",
    "",
    "[dn]",
    `CN = ${CN}`,
    "",
    "[v3_code]",
    "keyUsage = critical, digitalSignature",
    "extendedKeyUsage = codeSigning",
    "basicConstraints = critical, CA:FALSE",
    "",
  ].join("\n"),
);

function run(name: string, args: string[], label: string) {
  const proc = spawnSync(name, args, { stdio: "inherit" });
  if (proc.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`[signing:provision] ${label} failed`);
    process.exit(proc.status === null ? 1 : proc.status);
  }
}

try {
  console.info(`[signing:provision] generating certificate for CN=${CN}`);
  run(
    "openssl",
    [
      "req",
      "-x509",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "3650",
      "-config",
      opensslConfig,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    "openssl req -x509",
  );
  // macOS `security import` can't read OpenSSL 4.x default PKCS#12
  // parameters; export with the legacy SHA-1/3DES algorithms it accepts.
  run(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      keyPath,
      "-in",
      certPath,
      "-out",
      p12Path,
      "-macalg",
      "sha1",
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-password",
      `pass:${password}`,
    ],
    "openssl pkcs12 -export",
  );

  console.info(`[signing:provision] importing into ${LOGIN_KEYCHAIN}`);
  run(
    "security",
    ["import", p12Path, "-k", LOGIN_KEYCHAIN, "-P", password, "-T", "/usr/bin/codesign"],
    "security import",
  );

  console.info("[signing:provision] adding Code Signing trust setting");
  run("security", ["add-trusted-cert", "-p", "codeSign", "-k", LOGIN_KEYCHAIN, certPath], "security add-trusted-cert");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.info("[signing:provision] keychain identities available:");
run("security", ["find-identity", "-v", "-p", "codesigning"], "security find-identity");
console.info(
  "[signing:provision] done. Run `bun run --cwd cli build:darwin-arm64` to build and sign.",
);
