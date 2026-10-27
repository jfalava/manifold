/** @effect-diagnostics nodeBuiltinImport:off — Bounded OSC reports must flush before exit. */
/** @effect-diagnostics processEnv:off — Invocation-level terminal configuration. */
import { writeSync } from "node:fs";

import { Cause, Effect, Exit, Terminal } from "effect";

export interface TerminalSessionControls {
  readonly cancelled: boolean;
  phase(label: string): void;
  progress(done: number, total: number): void;
  blocked(kind: "permission" | "question" | "auth", label: string): void;
  resume(): void;
  cancel(): void;
  summary(message: string, hasErrors?: boolean): void;
  close(outcome: "done" | "idle" | "error"): void;
}

export interface TerminalSessionOptions {
  stream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

/** Also strip bidi overrides: titles and provider text must not inject terminal commands. */
export const terminalText = (text: string, limit = 192): string => {
  const cleaned = text
    // oxlint-disable-next-line no-control-regex -- Sanitize OSC metadata and live labels.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let result = "";
  let bytes = 0;
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) {
      break;
    }
    result += character;
  }
  return result;
};

export const createTerminalSession = (
  options: TerminalSessionOptions = {},
): TerminalSessionControls => {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  let enabled = stream.isTTY === true && env.TERM !== "dumb" && env.MANIFOLD_PROGRAM_STATUS !== "0";
  let phase = "Working";
  let percentage: number | undefined;
  let kind: "permission" | "question" | "auth" | undefined;
  let blockedLabel: string | undefined;
  let summary: string | undefined;
  let errors = false;
  let cancelled = false;
  let closed = false;
  let begun = false;
  let previous: string | undefined;
  const publish = (state: "working" | "blocked" | "idle" | "done" | "error", label: string) => {
    if (!enabled || !begun) {
      return;
    }
    const progress = state === "working" || state === "blocked" ? percentage : undefined;
    const suffix = progress === undefined ? "" : ` ${progress}%`;
    const title = terminalText(`manifold: ${label}`, 192 - Buffer.byteLength(suffix)) + suffix;
    const pairs = [
      `state=${state}`,
      "app=manifold",
      `title=${Buffer.from(title).toString("base64")}`,
    ];
    if (summary !== undefined) {
      pairs.push(`msg=${Buffer.from(summary).toString("base64")}`);
    }
    if (state === "blocked") {
      pairs.push(`kind=${kind}`);
    }
    if (progress !== undefined) {
      pairs.push(`progress=${progress}`);
    }
    const sequence = `\u001b]2;${title}\u001b\\\u001b]7501;${pairs.join(":")}\u001b\\`;
    if (sequence === previous) {
      return;
    }
    try {
      if (options.stream !== undefined) {
        stream.write(sequence);
      } else {
        const bytes = Buffer.from(sequence);
        let offset = 0;
        while (offset < bytes.length) {
          offset += writeSync(2, bytes, offset, bytes.length - offset);
        }
      }
      previous = sequence;
    } catch {
      enabled = false;
    }
  };
  return {
    get cancelled() {
      return cancelled;
    },
    phase(label) {
      if (closed) {
        return;
      }
      begun = true;
      const next = terminalText(label);
      if (phase !== next) {
        percentage = undefined;
      }
      phase = next;
      if (blockedLabel === undefined) {
        publish("working", phase);
      }
    },
    progress(done, total) {
      if (closed) {
        return;
      }
      percentage =
        total > 0 && Number.isFinite(total) && Number.isFinite(done)
          ? Math.floor((Math.max(0, Math.min(done, total)) * 100) / total)
          : undefined;
      publish(blockedLabel === undefined ? "working" : "blocked", blockedLabel ?? phase);
    },
    blocked(nextKind, label) {
      if (closed) {
        return;
      }
      begun = true;
      kind = nextKind;
      blockedLabel = terminalText(label);
      publish("blocked", blockedLabel);
    },
    resume() {
      if (closed || blockedLabel === undefined) {
        return;
      }
      blockedLabel = undefined;
      kind = undefined;
      publish("working", phase);
    },
    cancel() {
      cancelled = true;
    },
    summary(message, hasErrors = false) {
      if (closed) {
        return;
      }
      summary = terminalText(message, 2048);
      errors ||= hasErrors;
    },
    close(outcome) {
      if (closed) {
        return;
      }
      closed = true;
      const state = cancelled || outcome === "idle" ? "idle" : errors ? "error" : outcome;
      if (state === "idle") {
        summary = undefined;
      }
      publish(state, state === "idle" ? "Cancelled" : state === "error" ? "Failed" : "Done");
    },
  };
};

let current: TerminalSessionControls | undefined;
/** Promise-based Listr callbacks share the invocation's terminal session. */
export const terminalSession = (): TerminalSessionControls | undefined => current;

export const withTerminalSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const session = createTerminalSession();
    current = session;
    return Effect.yieldNow.pipe(
      Effect.andThen(effect),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          session.close(
            Exit.isSuccess(exit)
              ? process.exitCode
                ? "error"
                : "done"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "idle"
                : "error",
          );
          if (current === session) {
            current = undefined;
          }
        }),
      ),
    );
  });

export const withTerminalInput = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  kind: "permission" | "question" | "auth" = "question",
  label = "Waiting for input",
) =>
  Effect.suspend(() => {
    const session = current;
    session?.blocked(kind, label);
    return effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (Terminal.isQuitError(error)) {
            session?.cancel();
          }
        }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
            session?.cancel();
          }
          session?.resume();
        }),
      ),
    );
  });
