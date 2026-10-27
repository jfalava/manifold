/** @effect-diagnostics nodeBuiltinImport:off — Terminal streams are the UI boundary. */
import { stripVTControlCharacters } from "node:util";

import cliProgress from "cli-progress";
import cliTruncate from "cli-truncate";
import { Effect } from "effect";
import pc from "picocolors";
import stringWidth from "string-width";

import { envString, epochMillisNow } from "@/effect-kit";
import { terminalSession, terminalText } from "@/terminal-alert";

export interface ProgressOptions {
  stream?: NodeJS.WriteStream;
  announceNonTTY?: boolean;
}

let active: LiveProgress | undefined;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Invocation finalizer, including Effect interruption of a pending Promise callback. */
export const finishProgress = (): void => active?.finish();

/** Clear the transient region before a permanent report or diagnostic is written. */
export const writeOutput = (message: string, stream: NodeJS.WriteStream = process.stdout): void => {
  const current = active;
  current?.pause();
  stream.write(message);
  current?.resume();
};

/** One cli-progress owner for all live rows, never one renderer per callback. */
export class LiveProgress {
  private container: cliProgress.MultiBar | undefined;
  private bars: ReturnType<cliProgress.MultiBar["create"]>[] = [];
  private lines: string[] = [];
  private finished = false;
  private suspended = false;
  private renderedLines: string[] = [];
  private renderedColumns = 80;
  private readonly startedAt = epochMillisNow();
  readonly stream: NodeJS.WriteStream;
  readonly isTTY: boolean;

  constructor(options: ProgressOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.isTTY = this.stream.isTTY === true && envString("TERM") !== "dumb";
    active?.finish();
    // oxlint-disable-next-line typescript/no-this-alias -- Invocation finalizers must reach the current terminal owner.
    active = this;
    if (this.isTTY) {
      this.stream.on("resize", this.resize);
    }
  }

  private readonly resize = (): void => {
    if (!this.container) {
      return;
    }
    this.pause();
    this.resume();
  };

  update(lines: readonly string[]): void {
    if (this.finished) {
      return;
    }
    // Each logical status occupies one terminal row.
    this.lines = lines.map((line) => line.replace(/\r?\n/g, " "));
    if (!this.isTTY || this.suspended) {
      return;
    }
    if (this.lines.length === 0) {
      this.pause();
      this.suspended = false;
      return;
    }
    // Park on an empty row so terminals agree about whether the cursor row reflows.
    const visible = [...this.lines.slice(0, Math.max(1, (this.stream.rows ?? 24) - 3)), ""];
    if (this.bars.length !== visible.length) {
      this.pause();
    }
    this.suspended = false;
    if (this.container === undefined) {
      this.container = new cliProgress.MultiBar({
        stream: this.stream,
        format: "{line}",
        fps: 5,
        forceRedraw: true,
        hideCursor: true,
        // cli-progress's linewrap=true slices raw ANSI bytes, not terminal cells.
        linewrap: false,
        clearOnComplete: true,
        stopOnComplete: false,
        gracefulExit: false,
      });
      const pendingLines: string[] = [];
      this.container.on("redraw-post", () => {
        this.renderedLines = [...pendingLines];
        this.renderedColumns = Math.max(1, this.stream.columns ?? 80);
      });
      this.container.on("stop-pre-clear", () => {
        const columns = Math.max(1, this.stream.columns ?? 80);
        if (columns >= this.renderedColumns) {
          return;
        }
        // Correct reflow displacement of content rows, excluding the empty cursor row.
        // Never erase retained reports above the live region.
        let extraRows = 0;
        for (const line of this.renderedLines.slice(0, -1)) {
          let cells = 0;
          for (const { segment } of graphemes.segment(stripVTControlCharacters(line))) {
            const width = Math.min(columns, stringWidth(segment));
            if (cells + width > columns) {
              extraRows++;
              cells = 0;
            }
            cells += width;
          }
        }
        if (extraRows > 0) {
          this.stream.write(`\u001b[${extraRows}A`);
        }
      });
      this.bars = visible.map((line, index) =>
        this.container!.create(
          1,
          0,
          { line },
          {
            format: (options, params, payload) => {
              const columns = Math.max(1, this.stream.columns ?? 80);
              const formatted = cliTruncate(
                cliProgress.Format.Formatter(
                  {
                    ...options,
                    format: index === 0 ? "{line} · {duration_formatted}" : "{line}",
                  },
                  { ...params, startTime: this.startedAt },
                  payload,
                ),
                Math.max(1, columns - 1),
              );
              pendingLines[index] = formatted;
              return formatted;
            },
          },
        ),
      );
      this.container.update();
    } else {
      visible.forEach((line, index) => this.bars[index]!.update(0, { line }));
    }
  }

  pause(): void {
    this.suspended = true;
    this.container?.stop();
    this.container = undefined;
    this.bars = [];
    this.renderedLines = [];
  }

  resume(): void {
    this.suspended = false;
    if (!this.finished) {
      this.update(this.lines);
    }
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.pause();
    this.stream.off("resize", this.resize);
    if (active === this) {
      active = undefined;
    }
  }
}

/** Pause rendering while another input renderer owns the terminal. */
export const withProgressPaused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const current = active;
    current?.pause();
    return effect.pipe(Effect.ensuring(Effect.sync(() => current?.resume())));
  });

export const createProgress = (title: string, total?: number, options: ProgressOptions = {}) => {
  const live = new LiveProgress(options);
  let operationCount = total;
  let attempted = 0;
  let announced = false;
  let finished = false;
  let item = "";
  const update = (label: string) => {
    if (finished || operationCount === 0) {
      return;
    }
    terminalSession()?.phase(title);
    if (operationCount !== undefined) {
      terminalSession()?.progress(attempted, operationCount);
    }
    if (!live.isTTY && !announced && options.announceNonTTY !== false) {
      live.stream.write(
        `󰔛 ${title}${operationCount === undefined ? "" : ` (${operationCount} operations)`}\n`,
      );
      announced = true;
    }
    live.update([
      `${pc.cyan("󰔛")} ${pc.bold(terminalText(title, 4096))}${operationCount === undefined ? "" : ` · ${attempted}/${operationCount} · ${Math.floor((attempted * 100) / operationCount)}%`}`,
      ...(item ? [`    ${pc.blue("󰌗")} ${pc.dim(terminalText(item, 4096))}`] : []),
      ...(label
        ? [`${item ? "        " : "    "}${pc.dim("󰒓 " + terminalText(label, 4096))}`]
        : []),
    ]);
  };
  return {
    update: (done: number, count: number, label = title) => {
      attempted = done;
      operationCount = count;
      update(label);
    },
    item: (label: string) => {
      item = label;
      update("");
    },
    detail: (label: string) => update(label),
    log: (message: string) => writeOutput(`${message.replace(/\n+$/g, "")}\n`, live.stream),
    track: <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        update(label);
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (operationCount !== undefined) {
                attempted += 1;
              }
              update(label);
            }),
          ),
        );
      }),
    finish: () => {
      finished = true;
      live.finish();
    },
  };
};

export const withActivity = <A, E, R>(
  title: string,
  effect: Effect.Effect<A, E, R>,
  options?: ProgressOptions,
) =>
  Effect.suspend(() => {
    const progress = createProgress(title, undefined, options);
    progress.detail("");
    return effect.pipe(Effect.ensuring(Effect.sync(progress.finish)));
  });

export const withProgress = <A, E, R>(
  title: string,
  total: number,
  use: (progress: ReturnType<typeof createProgress>) => Effect.Effect<A, E, R>,
  options?: ProgressOptions,
) =>
  Effect.suspend(() => {
    const progress = createProgress(title, total, options);
    return Effect.suspend(() => use(progress)).pipe(Effect.ensuring(Effect.sync(progress.finish)));
  });
