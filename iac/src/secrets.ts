/** @effect-diagnostics nodeBuiltinImport:off */
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type SecretsStoreResource = Cloudflare.SecretsStore.Store;
type SecretResource = Cloudflare.SecretsStore.Secret;

export type ManagedSecrets = Readonly<Record<string, SecretResource>>;

// Workers ambient typings make bare `process` `any`. Reach the Node env map
// through a narrow globalThis shape so type-aware lint stays honest.
type ProcessEnvMap = Record<string, string | undefined>;
type ProcessHost = { readonly env: ProcessEnvMap };

const processHost = (): ProcessHost | undefined => {
  // SAFETY: optional field is { process?: ProcessHost } when present at this call site
  const host = globalThis as { process?: ProcessHost };
  return host.process;
};

const readProcessEnv = (key: string): string | undefined => processHost()?.env[key];

const writeProcessEnv = (key: string, value: string): void => {
  const host = processHost();
  if (host === undefined || host.env[key] !== undefined) {
    return;
  }
  host.env[key] = value;
};

const iacEnvFile = resolve(import.meta.dirname, "../.env");

const readIacEnv = (): Map<string, string> => {
  let contents: string;
  try {
    contents = readFileSync(iacEnvFile, "utf8");
  } catch {
    return new Map();
  }

  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) {
      continue;
    }

    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue.replace(/\s+#.*$/u, "").trim();
    values.set(key, value);
    writeProcessEnv(key, value);
  }

  return values;
};

const iacEnv = readIacEnv();

/** Secret value from process env or iac/.env under the bare MANIFOLD_* name. */
const managedSecretValue = (secretName: string): string | undefined =>
  readProcessEnv(secretName) ?? iacEnv.get(secretName);

/**
 * Resolves a secret value for local development (`alchemy dev`) as a
 * redacted plain-string Worker binding. Local workers accept string secrets
 * directly, which avoids booting a Secrets Store gateway per secret.
 */
export const localSecretValue = (secretName: string): Redacted.Redacted<string> => {
  const value = managedSecretValue(secretName);

  if (value === undefined || value === "") {
    throw new Error(`Missing local secret ${secretName}. Set ${secretName} in iac/.env.`);
  }

  return Redacted.make(value);
};

/**
 * Declares the secrets explicitly supplied for this Alchemy run as Secrets
 * Store Secret resources. Values come from the bare MANIFOLD_* env names in
 * iac/.env (or the process environment). Names without a supplied value are
 * skipped — they must already exist in the account store for their bindings
 * to resolve.
 */
export const defineManagedSecrets = Effect.fn("defineManagedSecrets")(function* (
  store: SecretsStoreResource,
  secretNames: readonly string[],
) {
  const managed: Record<string, SecretResource> = {};

  for (const secretName of secretNames) {
    const value = managedSecretValue(secretName);
    if (value === undefined || value === "") {
      continue;
    }

    managed[secretName] = yield* Cloudflare.SecretsStore.Secret(`ManagedSecret${secretName}`, {
      store,
      name: secretName,
      value: Redacted.make(value),
    }).pipe(adopt(true), retain());
  }

  return managed;
});
