import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import pc from "picocolors";
import cliProgress from "cli-progress";
import { Listr, PRESET_TIMER, Spinner, type ListrTask } from "listr2";

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

export const frameDetail = (text: string): void => {
  process.stdout.write(`${muted("│")}  ${muted(text)}\n`);
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

export const confirmInFrame = async (message: string): Promise<boolean> => {
  stdout.write(`${muted("│")}\n${muted("│")}  ${message} (yes/no): `);
  const reader = createInterface({ input: stdin, output: stdout });
  const answer = (await reader.question("")).trim().toLowerCase();
  reader.close();
  return answer === "yes";
};

export const waitForEnterInFrame = async (message: string): Promise<void> => {
  stdout.write(`${muted("│")}\n${muted("│")}  ${message} `);
  const reader = createInterface({ input: stdin, output: stdout });
  await reader.question("");
  reader.close();
};

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
  const rateMs = done > 0 ? (Date.now() - startedAt) / done : 0;
  const remaining = Math.max(total - done, 0);
  const etaSec = remaining > 0 && done > 0 ? (rateMs * remaining) / 1000 : 0;
  const countText = counts.map(([label, value]) => ` ${label}=${value}`).join("");
  const elapsedText = ` · elapsed=${fmtDuration(Date.now() - startedAt)}`;
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
      startedAt ??= Date.now();
      task.output = barLine({ done, total, counts, startedAt });
    },
  };
};
