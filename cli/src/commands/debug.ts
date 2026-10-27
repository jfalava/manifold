/** @effect-diagnostics nodeBuiltinImport:off — Set the tour's terminal title synchronously. */
/** @effect-diagnostics asyncFunction:off — Listr callbacks are Promise host boundaries. */
import { writeSync } from "node:fs";

import { errorMessage } from "@manifold/json";
import { Duration, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { cliError, fromPromise, sleepPromise } from "@/effect-kit";
import {
  BLOCKED_KINDS,
  emitProgramStatus,
  PROGRAM_STATES,
  type ProgramStatus,
  type StatusTerminator,
} from "@/program-status";
import { terminalSession } from "@/terminal-alert";
import {
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  ui,
  writeOutput,
} from "@/ui";

const TOUR_ID = "manifold-status-demo";
const ROOT = { app: "manifold" } as const;

const tour: ReadonlyArray<{ caption: string; reports: ReadonlyArray<ProgramStatus> }> = [
  { caption: "Idle", reports: [{ ...ROOT, state: "idle", message: "Ready for an instruction" }] },
  {
    caption: "Working, indeterminate",
    reports: [{ ...ROOT, state: "working", message: "Starting demo" }],
  },
  ...[0, 37, 100].map((progress) => ({
    caption: `Working ${progress}%`,
    reports: [
      {
        ...ROOT,
        state: "working",
        progress,
        message: "Simulated progress",
      } satisfies ProgramStatus,
    ],
  })),
  {
    caption: "Working, percentage removed",
    reports: [{ ...ROOT, state: "working", message: "No percentage available" }],
  },
  {
    caption: "Blocked, no kind",
    reports: [{ ...ROOT, state: "blocked", message: "Waiting for the user" }],
  },
  ...BLOCKED_KINDS.flatMap((kind) => [
    {
      caption: `Waiting for ${kind}`,
      reports: [
        {
          ...ROOT,
          state: "blocked",
          kind,
          message: `Simulated ${kind}, no action required`,
        } satisfies ProgramStatus,
      ],
    },
    {
      caption: `Waiting for ${kind} 37%`,
      reports: [
        {
          ...ROOT,
          state: "blocked",
          kind,
          progress: 37,
          message: `Simulated ${kind} at 37%`,
        } satisfies ProgramStatus,
      ],
    },
  ]),
  { caption: "Done", reports: [{ ...ROOT, state: "done", message: "Simulated result is ready" }] },
  {
    caption: "Error, simulation only",
    reports: [{ ...ROOT, state: "error", message: "Simulated failure, nothing actually failed" }],
  },
  {
    caption: "Concurrent records, app inheritance and override",
    reports: [
      { ...ROOT, state: "working", message: "Root and children are active" },
      { state: "working", id: TOUR_ID, title: "Demo tasks", message: "Inherits app=manifold" },
      { state: "working", id: `${TOUR_ID}/build`, title: "Build", progress: 37 },
      {
        state: "blocked",
        id: `${TOUR_ID}/build/approval`,
        kind: "permission",
        title: "Approval",
        message: "Approve demo build?",
      },
      {
        state: "working",
        id: `${TOUR_ID}/sibling`,
        app: "manifold-worker",
        title: "Worker override",
      },
    ],
  },
  {
    caption: "Unicode and delimiter-containing text",
    reports: [
      {
        state: "working",
        id: `${TOUR_ID}/sibling`,
        app: "manifold-worker",
        title: "Español 日本語",
        progress: 0,
        message: "Demo: key=value; café ☕",
      },
    ],
  },
  {
    caption: "Replacement removes title, message, progress and app override",
    reports: [{ state: "working", id: `${TOUR_ID}/sibling` }],
  },
  {
    caption: "Clear a leaf, keep its parent and sibling",
    reports: [{ state: "clear", id: `${TOUR_ID}/build/approval` }],
  },
  {
    caption: "Recreate nested child",
    reports: [
      {
        state: "done",
        id: `${TOUR_ID}/build/approval`,
        title: "Approval",
        message: "Simulated approval complete",
      },
    ],
  },
  {
    caption: "Clear build subtree, keep sibling",
    reports: [{ state: "clear", id: `${TOUR_ID}/build` }],
  },
];

const caption = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

const emitTourRoot = Effect.fnUntraced(function* (
  step: string,
  report: ProgramStatus,
  terminator: StatusTerminator,
) {
  const title = `manifold: ${step}`;
  yield* Effect.try({
    try: () => {
      writeSync(1, `\u001b]2;${title}${terminator === "bel" ? "\u0007" : "\u001b\\"}`);
    },
    catch: (cause) => cliError(`Could not set terminal window title: ${errorMessage(cause)}`),
  });
  yield* emitProgramStatus({ ...ROOT, ...report, title }, terminator);
});

const runTour = Effect.fnUntraced(function* (interval: number, terminator: StatusTerminator) {
  yield* caption(
    "OSC 7501 tour. Switch to another Rex tab or session picker to inspect indicators.",
  );
  yield* caption(
    "This replaces the root status and uses the manifold-status-demo subtree. No real work or authentication occurs.",
  );
  yield* Effect.gen(function* () {
    for (const [index, step] of tour.entries()) {
      yield* caption(`[${index + 1}/${tour.length}] ${step.caption}`);
      const root =
        step.reports.find((report) => report.id === undefined) ??
        ({
          state: "working",
          message: step.caption,
        } satisfies ProgramStatus);
      yield* emitTourRoot(step.caption, root, terminator);
      for (const report of step.reports) {
        if (report.id !== undefined) {
          yield* emitProgramStatus(report, terminator);
        }
      }
      yield* Effect.sleep(Duration.seconds(interval));
    }
    yield* emitProgramStatus({ state: "clear", id: TOUR_ID }, terminator);
    yield* emitTourRoot(
      "Done",
      { state: "done", message: "Program status tour finished" },
      terminator,
    );
    yield* caption("Tour finished. Root done is left for Rex to retain after the shell prompt.");
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        yield* emitProgramStatus({ state: "clear", id: TOUR_ID }, terminator);
        yield* emitTourRoot("Cancelled", { state: "idle" }, terminator);
      }),
    ),
  );
});

const programStatusCommand = Command.make(
  "program-status",
  {
    state: Flag.Literals("state", PROGRAM_STATES).pipe(
      Flag.optional,
      Flag.withDescription("Emit one state instead of running the tour."),
    ),
    kind: Flag.Literals("kind", BLOCKED_KINDS).pipe(
      Flag.optional,
      Flag.withDescription("Blocked reason, with --state blocked only."),
    ),
    progress: Flag.Int("progress").pipe(
      Flag.optional,
      Flag.withDescription("Percentage 0..100, with working or blocked only."),
    ),
    id: Flag.String("id").pipe(
      Flag.optional,
      Flag.withDescription("Record path. Omit to address the root."),
    ),
    app: Flag.String("app").pipe(
      Flag.optional,
      Flag.withDescription("Stable program identifier. Omit to test absent or inherited app."),
    ),
    title: Flag.String("title").pipe(
      Flag.optional,
      Flag.withDescription("Single-line record label, encoded as UTF-8 base64."),
    ),
    message: Flag.String("message").pipe(
      Flag.optional,
      Flag.withDescription("Single-line status message, encoded as UTF-8 base64."),
    ),
    interval: Flag.Finite("interval").pipe(
      Flag.optional,
      Flag.withDescription("Seconds per tour step. Default: 5. Tour only."),
    ),
    hold: Flag.Boolean("hold").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Keep a targeted status running until Ctrl-C. Not valid with clear."),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Allow OSC bytes on non-TTY stdout, for capture or testing."),
    ),
    terminator: Flag.Literals("terminator", ["st", "bel"]).pipe(
      Flag.withDefault("st"),
      Flag.withDescription("OSC terminator. Default: st (ESC backslash)."),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const state = Option.getOrUndefined(flags.state);
      const interval = Option.getOrUndefined(flags.interval);
      const fields = {
        kind: Option.getOrUndefined(flags.kind),
        progress: Option.getOrUndefined(flags.progress),
        id: Option.getOrUndefined(flags.id),
        app: Option.getOrUndefined(flags.app),
        title: Option.getOrUndefined(flags.title),
        message: Option.getOrUndefined(flags.message),
      };
      if (
        state === undefined &&
        (flags.hold || Object.values(fields).some((value) => value !== undefined))
      ) {
        return yield* cliError("Payload flags and --hold require --state.");
      }
      if (state !== undefined && interval !== undefined) {
        return yield* cliError("--interval is only valid for the tour, without --state.");
      }
      if (interval !== undefined && (interval <= 0 || interval > 3600)) {
        return yield* cliError("--interval must be greater than 0 and at most 3600 seconds.");
      }
      if (state === "clear" && flags.hold) {
        return yield* cliError("--hold cannot be used with --state clear.");
      }
      if (!process.stdout.isTTY && !flags.force) {
        return yield* cliError(
          "Program status requires TTY stdout. Use --force to capture OSC bytes.",
        );
      }
      // Let runMain install signal handlers before publishing a status the user can interrupt.
      yield* Effect.yieldNow;
      if (state === undefined) {
        return yield* runTour(interval ?? 5, flags.terminator);
      }
      if (state === "clear" && fields.id === undefined) {
        yield* caption("Warning: clearing ALL program status records on this terminal.");
      }
      const emit = Effect.gen(function* () {
        yield* emitProgramStatus({ state, ...fields }, flags.terminator);
        yield* caption(
          `Emitted ${state} for ${fields.id ?? "root"}.${flags.hold ? " Holding until Ctrl-C." : ""}`,
        );
        if (flags.hold) {
          return yield* Effect.never;
        }
      });
      if (flags.hold) {
        return yield* emit.pipe(
          Effect.onInterrupt(() =>
            emitProgramStatus({ state: "idle", id: fields.id, app: fields.app }, flags.terminator),
          ),
        );
      }
      yield* emit;
    }),
).pipe(
  Command.withDescription(
    "Exercise OSC 7501 program status in Rex or another supporting terminal. No network requests.",
  ),
);

const uiCommand = Command.make(
  "ui",
  {
    interval: Flag.Finite("interval").pipe(
      Flag.withDefault(1),
      Flag.withDescription("Seconds per sample state. Default: 1. No network or writes."),
    ),
    state: Flag.Literals("state", ["all", "running", "paused", "error", "nested"]).pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Choose a sample state, or exercise the whole gallery."),
    ),
  },
  ({ interval, state }) =>
    Effect.gen(function* () {
      if (interval <= 0 || interval > 3600) {
        return yield* cliError("--interval must be greater than 0 and at most 3600.");
      }
      openFrame("manifold · output gallery");
      frameDetail("Fixed sample data · no network, credentials, or registry writes");
      const wait = () => sleepPromise(interval * 1000);
      const run = createRun([
        {
          title: "Load registry rows",
          task: async (_ctx, task) => {
            makePhaseReporter(task).note("104 eligible; 104 to check");
            await wait();
          },
        },
        {
          title: "Search MangaNato and verify titles/authors",
          enabled: () => state !== "nested",
          task: async (_ctx, task) => {
            const reporter = makePhaseReporter(task);
            reporter.item("35/104 Shoujotachi wa Kouya wo Mezasu: Yukidoke no Oto");
            reporter.detail("/search/story/shoujotachi_wa_kouya_wo_mezasu?page=3");
            reporter.progress(34, 104, [
              ["matched", 28],
              ["review", 6],
            ]);
            await wait();
            // Stress the same three rows: none of these intermediate labels may enter scrollback.
            for (let index = 0; index < 200; index++) {
              reporter.detail(`Searching catalog · update ${index + 1}`);
            }
            reporter.item("40/104 Uchi no Maid ga Class no Suki na Ko ni Niteiru");
            reporter.progress(39, 104, [
              ["matched", 32],
              ["review", 7],
            ]);
            if (state === "all" || state === "paused") {
              terminalSession()?.blocked("auth", "Solve MangaNato challenge in Chrome");
              reporter.detail(
                "PAUSED · solve challenge in Chrome · Enter retries · Ctrl-C cancels",
              );
              await wait();
              terminalSession()?.resume();
            }
            reporter.detail("Retrying the paused MangaNato request");
            await wait();
            if (state === "all" || state === "error") {
              reporter.problem("Sample provider timeout. No real request was made.");
              await wait();
            }
            reporter.note("SELECTION sample-entry → manganato:sample · author verified");
            reporter.progress(40, 104, [
              ["matched", 33],
              ["review", 7],
            ]);
            await wait();
          },
        },
        {
          title: "Push to AniList (sample dry run)",
          enabled: () => state === "all" || state === "nested",
          task: (_ctx, task) =>
            task.newListr([
              {
                title: "Fetch MangaDex read markers",
                task: async (_subCtx, subTask) => {
                  const reporter = makePhaseReporter(subTask);
                  reporter.item(
                    "3/7 Español 日本語 · A very long title that must stay on one terminal row",
                  );
                  reporter.detail("GET /manga/sample/read · retry 2/3");
                  reporter.progress(2, 7);
                  await wait();
                },
              },
            ]),
        },
      ]);
      yield* fromPromise(() => run.run());
      writeOutput(
        `${ui.warning("Sample warning with a retained diagnostic\nContinuation stays indented.")}\n`,
        process.stderr,
      );
      closeFrame("Preview finished · no changes made");
    }),
).pipe(
  Command.withDescription(
    "Preview the real CLI printers, nested progress, challenge pause and retained reports offline.",
  ),
);

export const debugCommand = Command.make("debug").pipe(
  Command.withDescription("Local diagnostic commands."),
  Command.withSubcommands([uiCommand, programStatusCommand]),
);
