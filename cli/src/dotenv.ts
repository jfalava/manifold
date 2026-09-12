/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { readFileSync } from "node:fs";

/**
 * Minimal KEY=VALUE loader. Sets values into process.env only when unset, so
 * real environment variables always win over file contents.
 */
export const loadDotEnv = (file: string): void => {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return;
  }
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
    if (value !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};
