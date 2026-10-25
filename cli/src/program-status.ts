/** @effect-diagnostics nodeBuiltinImport:off — OSC reports are synchronous terminal writes. */
import { writeSync } from "node:fs";

import { errorMessage } from "@manifold/json";
import { Effect, Schema } from "effect";

import { cliError } from "@/effect-kit";

export const PROGRAM_STATES = ["idle", "working", "blocked", "done", "error", "clear"] as const;
export const BLOCKED_KINDS = ["permission", "question", "auth"] as const;

const singleLine = (limit: number) =>
  Schema.String.check(
    Schema.makeFilter((value) =>
      // eslint-disable-next-line no-control-regex -- OSC text explicitly forbids C0, DEL and C1.
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)
        ? "Text must not contain control characters."
        : Buffer.byteLength(value, "utf8") <= limit || `Text exceeds ${limit} UTF-8 bytes.`,
    ),
  );

const ProgramStatus = Schema.Struct({
  state: Schema.Literals(PROGRAM_STATES),
  id: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/),
      Schema.isMaxLength(128),
    ),
  ),
  kind: Schema.optional(Schema.Literals(BLOCKED_KINDS)),
  progress: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  app: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.+-]{1,32}$/))),
  title: Schema.optional(singleLine(192)),
  message: Schema.optional(singleLine(2048)),
}).check(
  Schema.makeFilter((report) => {
    if (report.kind !== undefined && report.state !== "blocked") {
      return "--kind requires --state blocked.";
    }
    if (report.progress !== undefined && report.state !== "working" && report.state !== "blocked") {
      return "--progress requires --state working or blocked.";
    }
    if (
      report.state === "clear" &&
      (report.app !== undefined || report.title !== undefined || report.message !== undefined)
    ) {
      return "--state clear accepts only --id, not metadata.";
    }
    return true;
  }),
);

export type ProgramStatus = typeof ProgramStatus.Type;
export type StatusTerminator = "st" | "bel";

/** OSC 7501 revision 0.4. Each report is complete, with no retained sender state. */
export const encodeProgramStatus = Effect.fnUntraced(function* (
  report: ProgramStatus,
  terminator: StatusTerminator = "st",
) {
  const valid = yield* Schema.decodeEffect(ProgramStatus)(report).pipe(
    Effect.mapError((cause) => cliError(errorMessage(cause))),
  );
  const pairs = [`state=${valid.state}`];
  for (const key of ["id", "kind", "progress", "app", "title", "message"] as const) {
    const value = valid[key];
    if (value !== undefined) {
      const encoded =
        key === "title" || key === "message"
          ? Buffer.from(String(value), "utf8").toString("base64")
          : String(value);
      pairs.push(`${key === "message" ? "msg" : key}=${encoded}`);
    }
  }
  return `\u001b]7501;${pairs.join(":")}${terminator === "bel" ? "\u0007" : "\u001b\\"}`;
});

/** Flush each bounded report before returning or handling an interrupt. */
export const emitProgramStatus = Effect.fnUntraced(function* (
  report: ProgramStatus,
  terminator: StatusTerminator = "st",
) {
  const sequence = yield* encodeProgramStatus(report, terminator);
  yield* Effect.try({
    try: () => {
      const bytes = Buffer.from(sequence);
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(1, bytes, offset, bytes.length - offset);
      }
    },
    catch: (cause) => cliError(`Could not write program status: ${errorMessage(cause)}`),
  });
});
