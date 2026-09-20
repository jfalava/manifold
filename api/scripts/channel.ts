/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalConsole:off */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type DeployChannel = "stable" | "beta";

export type ChannelConfig = {
  /** Raw `ENV` value from the process or `iac/.env`. */
  readonly envValue: "manifold-stable" | "manifold-beta";
  /** Paperback catalog path segment (`/extensions/0.9/{channel}`). */
  readonly channel: DeployChannel;
  /** Paperback extension id (bundle folder name + `source.<id>` export). */
  readonly extensionId: "MANIFOLD" | "MANIFOLD-beta";
  /** Display name shown in Paperback. */
  readonly extensionName: string;
  /** Optional version suffix appended to `package.json` version. */
  readonly versionSuffix: "" | "-beta";
  /** Badge label on the extension card. */
  readonly badgeLabel: "stable" | "beta";
  readonly badgeBackground: string;
  readonly description: string;
};

const STABLE: ChannelConfig = {
  envValue: "manifold-stable",
  channel: "stable",
  extensionId: "MANIFOLD",
  extensionName: "MANIFOLD",
  versionSuffix: "",
  badgeLabel: "stable",
  badgeBackground: "#0f766e",
  description: "Canonical registry and progress orchestration for native Paperback providers",
};

const BETA: ChannelConfig = {
  envValue: "manifold-beta",
  channel: "beta",
  extensionId: "MANIFOLD-beta",
  extensionName: "MANIFOLD beta",
  versionSuffix: "-beta",
  badgeLabel: "beta",
  badgeBackground: "#4f39f6",
  description: "Current-tree beta channel for MANIFOLD (install alongside stable under a separate id)",
};

type ProcessEnvMap = Record<string, string | undefined>;
type ProcessHost = { readonly env: ProcessEnvMap };

const processHost = (): ProcessHost | undefined => {
  // SAFETY: optional field is { process?: ProcessHost } when present at this call site
  const host = globalThis as { process?: ProcessHost };
  return host.process;
};

const readProcessEnv = (key: string): string | undefined => processHost()?.env[key];

const iacEnvFile = resolve(import.meta.dirname, "../../iac/.env");

const readIacEnvValue = (key: string): string | undefined => {
  let contents: string;
  try {
    contents = readFileSync(iacEnvFile, "utf8");
  } catch {
    return undefined;
  }

  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) {
      continue;
    }

    const [, envKey, rawValue] = match;
    if (!envKey || rawValue === undefined || envKey !== key) {
      continue;
    }

    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      return rawValue.slice(1, -1);
    }

    return rawValue.replace(/\s+#.*$/u, "").trim();
  }

  return undefined;
};

/** `ENV` from the process environment, else `iac/.env`. */
export const readDeployEnv = (): string | undefined => {
  const fromProcess = readProcessEnv("ENV")?.trim();
  if (fromProcess !== undefined && fromProcess.length > 0) {
    return fromProcess;
  }

  const fromFile = readIacEnvValue("ENV")?.trim();
  if (fromFile !== undefined && fromFile.length > 0) {
    return fromFile;
  }

  return undefined;
};

/**
 * Resolve the deploy/build channel from `ENV`.
 * - `manifold-stable` → stable catalog + `MANIFOLD` id
 * - `manifold-beta` → beta catalog + `MANIFOLD-beta` id
 *
 * Call with no argument to read process env / `iac/.env`. Pass an explicit
 * string (including `""`) to validate that value without reading the file.
 */
export function resolveChannel(): ChannelConfig;
export function resolveChannel(rawEnv: string): ChannelConfig;
export function resolveChannel(rawEnv?: string): ChannelConfig {
  const value = (arguments.length === 0 ? readDeployEnv() : rawEnv)?.trim();
  if (value === "manifold-stable") {
    return STABLE;
  }
  if (value === "manifold-beta") {
    return BETA;
  }

  const shown = value === undefined || value === "" ? "<unset>" : value;
  throw new Error(
    `ENV must be "manifold-stable" or "manifold-beta" (process env or iac/.env). Got: ${shown}`,
  );
}

export const channelConfig = (): ChannelConfig => resolveChannel();
