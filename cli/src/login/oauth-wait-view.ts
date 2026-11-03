/**
 * Live "waiting for browser authorization" block for raw-TTY logins, modelled
 * on alchemy's ExternalWait: spinner line, the authorize URL, and a key bar
 * whose entries change in place (c → ✓ copied).
 */
/** @effect-diagnostics globalTimers:off */
import { stripVTControlCharacters } from "node:util";

import pc from "picocolors";
import stringWidth from "string-width";

import { terminalHyperlink } from "@/ui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export type WaitKey = { readonly key: string; readonly label: string };

export type WaitViewState = {
  readonly frame: number;
  readonly label: string;
  readonly url: string;
  readonly hint?: string | undefined;
  readonly warning?: string | undefined;
  readonly keys: readonly WaitKey[];
};

export const renderWaitView = (state: WaitViewState): string[] => {
  const spinner = pc.cyan(SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length] ?? "");

  const keys = state.keys
    .map(({ key, label }) => `${pc.bold(pc.cyan(key))} ${pc.dim(label)}`)
    .join(pc.dim(" • "));

  return [
    `  ${spinner} ${state.label}`,
    ...(state.hint === undefined ? [] : [`    ${pc.dim(state.hint)}`]),
    "",
    `  ${terminalHyperlink(state.url, pc.underline(pc.cyan(state.url)))}`,
    ...(state.warning === undefined ? [] : ["", `  ${pc.yellow(`! ${state.warning}`)}`]),
    "",
    `  ${keys}`,
  ];
};

/** Terminal rows a rendered line occupies once the terminal soft-wraps it. */
const rowsFor = (line: string, columns: number): number =>
  Math.max(1, Math.ceil(stringWidth(stripVTControlCharacters(line)) / columns));

export type WaitView = {
  readonly update: (patch: Partial<Omit<WaitViewState, "frame">>) => void;
  readonly clear: () => void;
};

export const createWaitView = (
  initial: Omit<WaitViewState, "frame">,
  stream: NodeJS.WriteStream = process.stderr,
): WaitView => {
  let state: WaitViewState = { ...initial, frame: 0 };
  let renderedRows = 0;
  let cleared = false;

  const erase = (): void => {
    if (renderedRows > 0) {
      stream.write(`\u001b[${renderedRows}A\r\u001b[J`);
      renderedRows = 0;
    }
  };

  const draw = (): void => {
    if (cleared) {
      return;
    }

    // A width of 0 (some ptys) means unknown, not one column.
    const columns = stream.columns || 80;
    const lines = renderWaitView(state);
    erase();
    stream.write(`${lines.join("\n")}\n`);
    renderedRows = lines.reduce((sum, line) => sum + rowsFor(line, columns), 0);
  };

  const timer = setInterval(() => {
    state = { ...state, frame: state.frame + 1 };
    draw();
  }, 80);

  timer.unref?.();

  stream.write("\u001b[?25l");
  draw();

  return {
    update: (patch) => {
      state = { ...state, ...patch };
      draw();
    },
    clear: () => {
      if (cleared) {
        return;
      }

      clearInterval(timer);
      erase();
      cleared = true;
      stream.write("\u001b[?25h");
    },
  };
};
