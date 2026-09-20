/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import pc from "picocolors";
import cliProgress from "cli-progress";
import { Listr, PRESET_TIMER, Spinner, type ListrTask } from "listr2";
import { Effect } from "effect";
/** @effect-diagnostics processEnv:off — NO_COLOR presence (incl. empty) is a host signal. */
import { envString, epochMillisNow } from "@/effect-kit";

/**
 * Terminal UI kit: listr2 owns the task tree (◆/■/◇ icons via the default
 * renderer theme, per-task timers through PRESET_TIMER, and a sequential
 * simple-renderer fallback when stdout is not a TTY); cli-progress formats
 * every live bar line that streams through a task's output. A thin
 * picocolors ┌/└ frame wraps the whole run so it keeps its opencode look.
 */

/** Muted slate matching opencode's chrome (pc.dim renders too faintly). */
export const muted = (() => {
  if (!pc.isColorSupported) {
    return (text: string): string => text;
  }
  const [r, g, b] = [100, 116, 139];
  return (text: string): string => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
})();

/** Visual width of the frame rail prefix `│  ` (not counting ANSI). */
const FRAME_RAIL_COLS = 3;

/**
 * Hard-wrap plain text to `width` columns so terminal soft-wrap cannot leave
 * continuation lines without the frame rail.
 */
export const wrapFrameText = (text: string, width: number): string[] => {
  const max = Math.max(8, width);
  if (text.length === 0) {
    return [""];
  }
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    lines.push(text.slice(i, i + max));
  }
  return lines;
};

const frameContentWidth = (): number => {
  const cols = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  return Math.max(24, cols - FRAME_RAIL_COLS);
};

/**
 * OSC 8 hyperlink when stdout is a TTY. Visible text stays copyable; click
 * opens `href` in terminals that support it (Ghostty, iTerm2, kitty, Windows
 * Terminal, VS Code, …). Non-TTY / dumb terminals get plain text.
 *
 * Spec: https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 */
export const terminalHyperlink = (href: string, label: string): string => {
  if (!stdout.isTTY || envDisablesHyperlinks()) {
    return label;
  }
  return `\u001b]8;;${href}\u0007${label}\u001b]8;;\u0007`;
};

const envDisablesHyperlinks = (): boolean => {
  // NO_COLOR is active when present, including empty string (https://no-color.org).
  if (process.env.NO_COLOR !== undefined) {
    return true;
  }
  return envString("TERM") === "dumb";
};

export const frameDetail = (text: string): void => {
  // Keep the side rail continuous across explicit newlines and soft wraps.
  const width = frameContentWidth();
  for (const paragraph of text.split("\n")) {
    for (const chunk of wrapFrameText(paragraph, width)) {
      process.stdout.write(`${muted("│")}  ${muted(chunk)}\n`);
    }
  }
};

/**
 * Print a URL inside the frame: soft-wrapped with a continuous rail, and as an
 * OSC 8 hyperlink per segment when the terminal supports clicks.
 */
export const frameUrl = (url: string): void => {
  const width = frameContentWidth();
  for (const chunk of wrapFrameText(url, width)) {
    const label = muted(chunk);
    process.stdout.write(`${muted("│")}  ${terminalHyperlink(url, label)}\n`);
  }
};

// ---------- frame ----------

export const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
};

export const openFrame = (title: string): void => {
  process.stdout.write(`┌  ${pc.bold(title)}\n`);
};

export const closeFrame = (message: string): void => {
  const [first, ...rest] = message.split("\n");
  process.stdout.write(`${muted("│")}\n${muted("│")}\n└  ${pc.bold(first ?? "")}\n`);
  for (const line of rest) {
    process.stdout.write(`${muted("│")}  ${line}\n`);
  }
};

export const abortFrame = (): void => {
  process.stdout.write(`${muted("│")}\n${muted("│")}\n${pc.red("■")}  ${pc.bold("Failed")}\n`);
};

export const confirmInFrame = (message: string): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      stdout.write(`${muted("│")}\n${muted("│")}  ${message} (yes/no): `);
      const reader = createInterface({ input: stdin, output: stdout });
      const answer = yield* Effect.promise(() => reader.question(""));
      reader.close();
      return answer.trim().toLowerCase() === "yes";
    }),
  );

export const waitForEnterInFrame = (message: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      stdout.write(`${muted("│")}\n${muted("│")}  ${message} `);
      const reader = createInterface({ input: stdin, output: stdout });
      yield* Effect.promise(() => reader.question(""));
      reader.close();
    }),
  );

/** Visible single-line prompt inside the open frame. */
export const promptInFrame = (message: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      stdout.write(`${muted("│")}\n${muted("│")}  ${message}: `);
      const reader = createInterface({ input: stdin, output: stdout });
      const answer = yield* Effect.promise(() => reader.question(""));
      reader.close();
      return answer;
    }),
  );

/**
 * Prompt that accepts Enter to keep `defaultValue` when provided.
 * Empty input with no default returns "".
 */
export const promptInFrameWithDefault = (
  message: string,
  defaultValue?: string,
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const suffix =
        defaultValue !== undefined && defaultValue.length > 0
          ? ` [${defaultValue}]`
          : "";
      stdout.write(`${muted("│")}\n${muted("│")}  ${message}${suffix}: `);
      const reader = createInterface({ input: stdin, output: stdout });
      const answer = yield* Effect.promise(() => reader.question(""));
      reader.close();
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        return defaultValue ?? "";
      }
      return trimmed;
    }),
  );

/**
 * Secret prompt: hides echo when stdin is a TTY with setRawMode.
 * Falls back to a visible prompt when raw mode is unavailable.
 */
export const promptSecretInFrame = (message: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      stdout.write(`${muted("│")}\n${muted("│")}  ${message}: `);
      const setRawMode = stdin.setRawMode?.bind(stdin);
      if (!stdin.isTTY || setRawMode === undefined) {
        const reader = createInterface({ input: stdin, output: stdout });
        const answer = yield* Effect.promise(() => reader.question(""));
        reader.close();
        return answer;
      }

      const answer = yield* Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            let value = "";
            const onData = (chunk: Buffer | string) => {
              const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
              for (const ch of text) {
                if (ch === "\n" || ch === "\r") {
                  cleanup();
                  stdout.write("\n");
                  resolve(value);
                  return;
                }
                if (ch === "\u0003") {
                  cleanup();
                  reject(new Error("Cancelled."));
                  return;
                }
                if (ch === "\u007f" || ch === "\b") {
                  if (value.length > 0) {
                    value = value.slice(0, -1);
                    stdout.write("\b \b");
                  }
                  continue;
                }
                if (ch < " ") {
                  continue;
                }
                value += ch;
                stdout.write("*");
              }
            };
            const cleanup = () => {
              stdin.off("data", onData);
              setRawMode(false);
              stdin.pause();
            };
            setRawMode(true);
            stdin.resume();
            stdin.on("data", onData);
          }),
      );
      return answer;
    }),
  );

// ---------- run factory ----------

/** Listr context bag; command modules extend this with their own fields. */
export interface RunContext {}

type RunTask<Ctx extends RunContext = RunContext> = ListrTask<Ctx>;

/** Glyphs sit on the pile; every title is preceded by two empty │ spacers so the pile stays continuous like opencode (2 pipes per line). */
const spaced = (icon: string): string => `${muted("│")}\n${muted("│")}\n${icon}`;

const RUN_ICONS = {
  PENDING: spaced(pc.cyan("◇")),
  COMPLETED: spaced(pc.green("◆")),
  COMPLETED_WITH_FAILED_SUBTASKS: spaced(pc.yellow("◆")),
  COMPLETED_WITH_FAILED_SISTER_TASKS: spaced(pc.yellow("◆")),
  FAILED: spaced(pc.red("■")),
  WAITING: spaced(muted("○")),
  SKIPPED_WITH_COLLAPSE: spaced(muted("◇")),
  SKIPPED_WITHOUT_COLLAPSE: spaced(muted("◇")),
  ROLLING_BACK: spaced(pc.yellow("◇")),
  ROLLED_BACK: spaced(pc.yellow("◆")),
  RETRY: spaced(pc.yellow("◇")),
  PAUSED: spaced(pc.yellow("◇")),
  CANCELLED: spaced(pc.red("■")),
  OUTPUT: `${muted("│")} `,
  OUTPUT_WITH_BOTTOMBAR: `${muted("│")} `,
} as const;

/** Spinner frames keep the pile — the running line is "│" "│" then "⠋ Title" so the glyph stays on the pile. */
class RailSpinner extends Spinner {
  spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map(
    (frame) => `${muted("│")}\n${muted("│")}\n${pc.cyan(frame)}`,
  );
}

/** Build a Listr run with our theme + non-TTY fallback baked in. */
export const createRun = <Ctx extends RunContext>(
  tasks: RunTask<Ctx>[],
): Listr<Ctx, "default", "simple"> =>
  new Listr<Ctx, "default", "simple">(tasks, {
    renderer: "default",
    fallbackRenderer: "simple",
    concurrent: false,
    exitOnError: true,
    rendererOptions: {
      timer: PRESET_TIMER,
      collapseSubtasks: false,
      collapseErrors: false,
      indentation: 0,
      icon: RUN_ICONS,
      spinner: new RailSpinner(),
    },
    fallbackRendererOptions: {
      timer: PRESET_TIMER,
      icon: {
        STARTED: spaced(pc.cyan("◇")),
        COMPLETED: spaced(pc.green("◆")),
        FAILED: spaced(pc.red("■")),
        SKIPPED: spaced(muted("◇")),
        OUTPUT: `${muted("│")} `,
        CANCELLED: spaced(pc.red("■")),
      },
    },
  });

// ---------- progress bar (cli-progress formatting, streamed as task output) ----------

const BAR_OPTIONS = {
  barsize: 24,
  barCompleteChar: "█",
  barIncompleteChar: "░",
  align: "left" as const,
  formatBar: (progress: number, options: { barsize?: number }): string => {
    const size = options.barsize ?? 24;
    const complete = Math.min(size, Math.floor(progress * size));
    return pc.cyan("█".repeat(complete)) + muted("░".repeat(size - complete));
  },
};

export interface BarUpdate {
  done: number;
  total: number;
  counts?: readonly [string, number][];
  startedAt: number;
}

/** Render one bar line via cli-progress; meant to be assigned to task.output. */
export const barLine = ({ done, total, counts = [], startedAt }: BarUpdate): string => {
  const progress = total > 0 ? Math.min(1, done / total) : 1;
  const rateMs = done > 0 ? (epochMillisNow() - startedAt) / done : 0;
  const remaining = Math.max(total - done, 0);
  const etaSec = remaining > 0 && done > 0 ? (rateMs * remaining) / 1000 : 0;
  const countText = counts.map(([label, value]) => ` ${label}=${value}`).join("");
  const elapsedText = ` · elapsed=${fmtDuration(epochMillisNow() - startedAt)}`;
  const etaText = done < total && etaSec > 0 ? ` · eta=${fmtDuration(etaSec * 1000)}` : "";
  return cliProgress.Format.Formatter(
    {
      ...BAR_OPTIONS,
      format: "{bar}{counts} · {value}/{total}{suffix}",
      formatTime: (t: number) => fmtDuration(t * 1000),
    },
    {
      progress,
      value: done,
      total,
      eta: etaSec,
      startTime: startedAt,
      stopTime: null,
      maxWidth: process.stdout.columns ?? 120,
    },
    {
      counts: countText,
      suffix: `${elapsedText}${etaText}`,
    },
  );
};

// ---------- phase reporter (consumed by md2al-core / anilist-wipe loops) ----------

export interface PhaseReporter {
  /** Transient context line shown under the running task title. */
  detail(text: string): void;
  /** Result worth keeping visible after the task completes. */
  note(text: string): void;
  /** Per-item problem line. */
  problem(text: string): void;
  /** Live bar update rendered with cli-progress. */
  progress(done: number, total: number, counts?: readonly [string, number][]): void;
}

interface OutputSink {
  output: unknown;
}

/** Map a listr2 task to the reporter interface core phases expect. */
export const makePhaseReporter = (task: OutputSink): PhaseReporter => {
  let startedAt: number | undefined;
  return {
    detail(text) {
      task.output = pc.dim(text);
    },
    note(text) {
      task.output = text;
    },
    problem(text) {
      task.output = `${pc.red("■")} ${text}`;
    },
    progress(done, total, counts) {
      startedAt ??= epochMillisNow();
      task.output = barLine({ done, total, counts, startedAt });
    },
  };
};
