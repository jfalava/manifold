/** @effect-diagnostics nodeBuiltinImport:off — Terminal UI host boundary. */
/** @effect-diagnostics processEnv:off — NO_COLOR presence is a terminal signal. */
import { BunServices } from "@effect/platform-bun";
import cliProgress from "cli-progress";
import { Effect, Redacted, Terminal } from "effect";
import { Prompt } from "effect/cli";
import { Listr, type ListrTask } from "listr2";
import pc from "picocolors";

import { envString, epochMillisNow } from "@/effect-kit";
import { terminalSession, withTerminalInput } from "@/terminal-alert";
import { withProgressPaused, writeOutput, type ProgressOptions } from "@/ui/progress";
import { ProgressRenderer, taskOutputs } from "@/ui/renderer";
import { ui } from "@/ui/style";

export { ui } from "@/ui/style";
export { createProgress, withActivity, withProgress, writeOutput } from "@/ui/progress";
export const muted = ui.muted;

/** Retained for URL consumers: each segment remains copyable in a narrow terminal. */
export const wrapFrameText = (text: string, width: number): string[] => {
  const max = Math.max(8, width);
  if (!text.length) {
    return [""];
  }
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    lines.push(text.slice(i, i + max));
  }
  return lines;
};

export const terminalHyperlink = (href: string, label: string): string =>
  !process.stdout.isTTY || process.env.NO_COLOR !== undefined || envString("TERM") === "dumb"
    ? label
    : `\u001b]8;;${href}\u0007${label}\u001b]8;;\u0007`;

/** Compatibility names for report printers; the old box/rail renderer is gone. */
export const frameDetail = (text: string): void => writeOutput(`${ui.info(text)}\n`);
export const frameUrl = (url: string): void => {
  for (const chunk of wrapFrameText(url, (process.stdout.columns ?? 80) - 4)) {
    writeOutput(`    ${terminalHyperlink(url, ui.key(chunk))}\n`);
  }
};
export const openFrame = (title: string): void => {
  terminalSession()?.phase(title);
  writeOutput(`${ui.heading(title)}\n`);
};
export const closeFrame = (message: string, hasErrors = Boolean(process.exitCode)): void => {
  terminalSession()?.summary(message, hasErrors);
  writeOutput(
    `${hasErrors || terminalSession()?.cancelled ? ui.warning(message) : ui.success(message.split("\n").join("\n  "))}\n`,
  );
};
export const abortFrame = (): void => {
  terminalSession()?.summary("Failed", true);
};

/** Effect's platform terminal defaults to stdout; prompts explicitly belong on stderr. */
const runPrompt = <A>(
  prompt: Prompt.Prompt<A>,
  message: string,
  kind: "question" | "permission" | "auth",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      return yield* Prompt.run(prompt).pipe(
        Effect.provideService(
          Terminal.Terminal,
          Terminal.make({
            ...terminal,
            columns: Effect.sync(() => process.stderr.columns ?? 80),
            rows: Effect.sync(() => process.stderr.rows ?? 24),
            display: (text) =>
              Effect.sync(() => {
                process.stderr.write(text);
              }),
          }),
        ),
      );
    }).pipe(withTerminalInputEffect(kind, message), Effect.provide(BunServices.layer)),
  );

const withTerminalInputEffect =
  (kind: "question" | "permission" | "auth", message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withProgressPaused(withTerminalInput(effect, kind, message));

export const confirmInFrame = (message: string): Promise<boolean> =>
  runPrompt(Prompt.Confirm({ message, initial: false }), message, "permission");
export const waitForEnterInFrame = (message: string): Promise<void> =>
  runPrompt(Prompt.String({ message }), message, "question").then(() => undefined);
export const promptInFrame = (message: string): Promise<string> =>
  runPrompt(Prompt.String({ message }), message, "question");
export const promptInFrameWithDefault = (message: string, defaultValue?: string): Promise<string> =>
  runPrompt(Prompt.String({ message, default: defaultValue }), message, "question");
export const promptSecretInFrame = (message: string): Promise<string> =>
  runPrompt(Prompt.Password({ message }), message, "auth").then(Redacted.value);

export const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

export interface RunContext {}
/** Keep Listr's execution, skip, nesting and cancellation contracts; replace only its UI. */
export const createRun = <Ctx extends RunContext>(
  tasks: ListrTask<Ctx>[],
  options: ProgressOptions = {},
) =>
  new Listr<Ctx, typeof ProgressRenderer, typeof ProgressRenderer>(tasks, {
    renderer: ProgressRenderer,
    fallbackRenderer: ProgressRenderer,
    rendererOptions: options,
    fallbackRendererOptions: options,
    concurrent: false,
    exitOnError: true,
  });

export interface BarUpdate {
  done: number;
  total: number;
  counts?: readonly [string, number][];
  startedAt: number;
}

export const barLine = ({ done, total, counts = [], startedAt }: BarUpdate): string => {
  const progress = total > 0 ? Math.min(1, done / total) : 1;
  const remaining = Math.max(total - done, 0);
  const etaSec = done > 0 ? (((epochMillisNow() - startedAt) / done) * remaining) / 1000 : 0;
  return cliProgress.Format.Formatter(
    {
      barsize: 6,
      barCompleteChar: "━",
      barIncompleteChar: "─",
      formatBar: (ratio: number) => {
        const complete = Math.min(6, Math.max(0, Math.floor(ratio * 6)));
        return pc.cyan("━".repeat(complete)) + pc.dim("─".repeat(6 - complete));
      },
      formatTime: (seconds: number) => fmtDuration(seconds * 1000),
      format: "[{bar}] {value}/{total} · {percentage}%{suffix}",
    },
    {
      progress,
      value: done,
      total,
      eta: etaSec,
      startTime: startedAt,
      stopTime: null,
      maxWidth: process.stderr.columns ?? 120,
    },
    {
      suffix: `${counts.map(([label, value]) => ` ${label}=${value}`).join("")} · elapsed=${fmtDuration(epochMillisNow() - startedAt)}${done < total && etaSec > 0 ? ` · eta=${fmtDuration(etaSec * 1000)}` : ""}`,
    },
  );
};

export interface PhaseReporter {
  /** Current item, one level below the phase. Replaces the previous item. */
  item?(text: string): void;
  /** Current subprocess, one level below the item. Replaces the previous detail. */
  detail(text: string): void;
  /** Retained report on stdout, not a status update. */
  note(text: string): void;
  /** Retained diagnostic on stderr. */
  problem(text: string): void;
  progress(done: number, total: number, counts?: readonly [string, number][]): void;
}

interface OutputSink {
  output: unknown;
  task?: object;
}

export const makePhaseReporter = (
  task: OutputSink,
): PhaseReporter & { item(text: string): void } => {
  let startedAt: number | undefined;
  const output = task.task === undefined ? undefined : taskOutputs.get(task.task);
  return {
    item(text) {
      if (output) {
        output.item(text);
      } else {
        task.output = text;
      }
    },
    detail(text) {
      if (output) {
        output.detail(text);
      } else {
        task.output = pc.dim(text);
      }
    },
    note(text) {
      if (output) {
        output.note(text);
      } else {
        task.output = text;
      }
    },
    problem(text) {
      if (output) {
        output.problem(text);
      } else {
        task.output = ui.error(text);
      }
    },
    progress(done, total, counts) {
      startedAt ??= epochMillisNow();
      const text = barLine({ done, total, counts, startedAt });
      if (output) {
        output.progress(text, done, total);
      } else {
        task.output = text;
      }
    },
  };
};
