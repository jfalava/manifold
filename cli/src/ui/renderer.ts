import {
  ListrTaskEventType,
  ListrTaskState,
  type ListrRenderer,
  type ListrRendererTask,
} from "listr2";
import pc from "picocolors";

import { terminalSession, terminalText } from "@/terminal-alert";
import { LiveProgress, writeOutput, type ProgressOptions } from "@/ui/progress";
import { ui } from "@/ui/style";

type RenderTask = ListrRendererTask<typeof ProgressRenderer>;
export interface TaskOutput {
  item(text: string): void;
  detail(text: string): void;
  progress(text: string, done: number, total: number): void;
  note(text: string): void;
  problem(text: string): void;
}
/** Keep retained reports distinct from replaceable status before Listr flattens output. */
export const taskOutputs = new WeakMap<object, TaskOutput>();

export class ProgressRenderer implements ListrRenderer {
  static nonTTY = true;
  static rendererOptions: ProgressOptions = {};
  static rendererTaskOptions = {};
  private live: LiveProgress | undefined;
  private active: RenderTask | undefined;
  private item = "";
  private detail = "";
  private progress = "";
  private ended = false;
  private disposers: (() => void)[] = [];

  constructor(
    private readonly tasks: RenderTask[],
    private readonly options: ProgressOptions,
  ) {}

  render(): void {
    this.live = new LiveProgress(this.options);
    this.subscribe(this.tasks);
  }

  end(): void {
    this.ended = true;
    this.live?.finish();
    this.disposers.forEach((dispose) => dispose());
    this.disposers = [];
  }

  private draw(task: RenderTask): void {
    if (this.ended || this.active !== task) {
      return;
    }
    const branch: RenderTask[] = [];
    for (let node: RenderTask | undefined = task; node; node = node.parent) {
      branch.unshift(node);
    }
    const lines = branch.map((node, depth) => {
      const title = terminalText(node.title ?? "Working", 4096);
      return `${"    ".repeat(depth)}${depth === 0 ? pc.cyan("󰔛") : pc.blue("󰌗")} ${depth === 0 ? pc.bold(title) : pc.dim(title)}`;
    });
    const depth = branch.length;
    if (this.item) {
      lines.push(`${"    ".repeat(depth)}${pc.blue("󰌗")} ${pc.dim(this.item)}`);
    }
    if (this.detail) {
      lines.push(`${"    ".repeat(depth + (this.item ? 1 : 0))}${pc.dim("󰒓 " + this.detail)}`);
    }
    if (this.progress) {
      lines.push(`${"    ".repeat(depth)}${this.progress}`);
    }
    this.live?.update(lines);
  }

  private subscribe(tasks: RenderTask[]): void {
    for (const task of tasks) {
      const output: TaskOutput = {
        item: (text) => {
          this.item = terminalText(text, 4096);
          this.detail = "";
          this.draw(task);
        },
        detail: (text) => {
          this.detail = terminalText(text, 4096);
          this.draw(task);
        },
        progress: (text, done, total) => {
          this.progress = text;
          terminalSession()?.progress(done, total);
          this.draw(task);
        },
        note: (text) => writeOutput(`${ui.note(text)}\n`),
        problem: (text) => writeOutput(`${ui.error(text)}\n`, process.stderr),
      };
      taskOutputs.set(task, output);
      const state = (next: ListrTaskState) => {
        if (next === ListrTaskState.STARTED) {
          this.active = task;
          this.item = this.detail = this.progress = "";
          this.live?.resume();
          terminalSession()?.phase(task.title ?? "Working");
          if (!this.live?.isTTY) {
            writeOutput(`󰔛 ${task.title ?? "Working"}\n`, process.stderr);
          }
          this.draw(task);
        } else if (next === ListrTaskState.CANCELLED) {
          terminalSession()?.cancel();
          terminalSession()?.close("idle");
          this.live?.finish();
        } else if (next === ListrTaskState.FAILED) {
          // The command boundary prints the original error once, after clearing progress.
          this.live?.pause();
        } else if (next === ListrTaskState.COMPLETED || next === ListrTaskState.SKIPPED) {
          if (this.active === task) {
            this.live?.pause();
          }
        }
      };
      const title = () => this.draw(task);
      const transient = (text: string) => output.detail(text);
      const subtasks = (children: RenderTask[]) => this.subscribe(children);
      task.on(ListrTaskEventType.STATE, state);
      task.on(ListrTaskEventType.TITLE, title);
      task.on(ListrTaskEventType.OUTPUT, transient);
      task.on(ListrTaskEventType.SUBTASK, subtasks);
      this.disposers.push(() => {
        task.off(ListrTaskEventType.STATE, state);
        task.off(ListrTaskEventType.TITLE, title);
        task.off(ListrTaskEventType.OUTPUT, transient);
        task.off(ListrTaskEventType.SUBTASK, subtasks);
        taskOutputs.delete(task);
      });
    }
  }
}
