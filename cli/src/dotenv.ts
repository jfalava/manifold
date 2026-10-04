/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
import { readFileSync } from "node:fs";

const stripInlineComment = (value: string): string => {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
};

const parseValue = (rawValue: string): string => {
  const value = stripInlineComment(rawValue).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

/**
 * Minimal KEY=VALUE loader. Sets values into process.env only when unset, so
 * real environment variables always win over file contents.
 *
 * Bootstrap-only (runs before BunRuntime). node:fs is intentional here; runtime
 * code should use Effect FileSystem after the program starts.
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
    const value = parseValue(rawValue);
    if (value !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};
