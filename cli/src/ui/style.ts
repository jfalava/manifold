import pc from "picocolors";

const statusLine = (icon: string, color: (value: string) => string, message: string): string =>
  message
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "")
    .split("\n")
    .map((line, index) => (index === 0 ? `  ${color(icon)} ${line}` : `    ${line}`))
    .join("\n");

/** The same small text vocabulary as outfitting-manager. Nerd Font required. */
export const ui = {
  success: (message: string): string => `${pc.green("✓")} ${message}`,
  key: (value: string): string => pc.cyan(value),
  hash: (value: string): string => pc.yellow(value),
  muted: (value: string): string => pc.dim(value),
  heading: (value: string): string => pc.bold(value),
  info: (message: string): string => statusLine("󰋼", pc.cyan, message),
  note: (message: string): string => statusLine("󰎞", pc.blue, message),
  warning: (message: string): string => statusLine("󰀪", pc.yellow, message),
  error: (message: string): string => statusLine("󰅚", pc.red, message),
};
