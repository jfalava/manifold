/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { encodeProgramStatus, type ProgramStatus } from "../src/program-status";

const encode = (report: ProgramStatus) => Effect.runPromise(encodeProgramStatus(report));
const run = (...flags: string[]) =>
  spawnSync("bun", ["index.ts", "debug", "program-status", ...flags], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    timeout: 15_000,
  });

const interruptAfter = async (args: string[], ready: string) => {
  const child = spawn("bun", args, {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  const interrupt = () => {
    if (!interrupted && (stdout + stderr).includes(ready)) {
      interrupted = true;
      child.kill("SIGINT");
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    interrupt();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    interrupt();
  });
  try {
    await once(child, "close", { signal: AbortSignal.timeout(10_000) });
    expect(interrupted).toBe(true);
    expect(child.exitCode).toBe(130);
    return stdout;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
};

describe("OSC 7501 reports", () => {
  it("encodes all fields, progress zero, Unicode and delimiters", async () => {
    expect(
      await encode({
        state: "blocked",
        id: "build/approval",
        kind: "auth",
        progress: 0,
        app: "manifold",
        title: "café",
        message: "a:b;c=d",
      }),
    ).toBe(
      "\x1b]7501;state=blocked:id=build/approval:kind=auth:progress=0:app=manifold:title=Y2Fmw6k=:msg=YTpiO2M9ZA==\x1b\\",
    );
    expect(await Effect.runPromise(encodeProgramStatus({ state: "done" }, "bel"))).toBe(
      "\x1b]7501;state=done\x07",
    );
  });

  it("does not retain metadata or percentages across reports", async () => {
    await encode({
      state: "working",
      app: "manifold",
      id: "build",
      title: "Build",
      message: "Running",
      progress: 37,
    });
    expect(await encode({ state: "working", id: "build" })).toBe(
      "\x1b]7501;state=working:id=build\x1b\\",
    );
  });

  it("enforces UTF-8 limits at the boundary, including a maximum-sized report", async () => {
    const report: ProgramStatus = {
      state: "blocked",
      kind: "permission",
      progress: 100,
      id: ["a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(29)].join("/"),
      app: "a".repeat(32),
      title: "é".repeat(96),
      message: "é".repeat(1024),
    };
    const result = await encode(report);
    expect(Buffer.byteLength(result)).toBeLessThan(4096);
    await expect(encode({ ...report, title: `${report.title}a` })).rejects.toThrow(
      "192 UTF-8 bytes",
    );
    await expect(encode({ ...report, message: `${report.message}a` })).rejects.toThrow(
      "2048 UTF-8 bytes",
    );
    await expect(encode({ ...report, id: `${report.id}a` })).rejects.toThrow();
  });

  it.each([
    { state: "done", progress: 0 },
    { state: "working", kind: "question" },
    { state: "working", progress: -1 },
    { state: "working", progress: 101 },
    { state: "working", progress: 1.5 },
    { state: "clear", message: "ignored?" },
    { state: "idle", app: "a".repeat(33) },
    { state: "idle", app: "manifold\n" },
    { state: "idle", id: "build\n" },
    { state: "idle", id: "build//test" },
    { state: "idle", id: Array(9).fill("a").join("/") },
    { state: "idle", id: "a".repeat(33) },
    { state: "idle", message: "line\nbreak" },
    { state: "idle", title: "control\u009f" },
  ] satisfies ProgramStatus[])("rejects invalid report %j", async (report) => {
    await expect(encode(report)).rejects.toThrow();
  });
});

describe("program status CLI", () => {
  it("registers help without emitting any reports", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("--hold");
    expect(result.stdout + result.stderr).toContain("--terminator");
    expect(result.stdout).not.toContain("\x1b]7501;");
  });

  it("refuses non-TTY stdout unless forced", () => {
    const result = run("--state", "done");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("TTY stdout");
    expect(result.stdout).not.toContain("\x1b]7501;");
  });

  it.each(["done", "error"])("leaves %s intact on successful exit", (state) => {
    const result = run("--force", "--state", state, "--message", "Demo");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`\x1b]7501;state=${state}:msg=RGVtbw==\x1b\\`);
    expect(result.stderr).toContain(`Emitted ${state}`);
  });

  it("supports every payload flag and BEL through the real entry point", () => {
    const result = run(
      "--force",
      "--state",
      "blocked",
      "--kind",
      "question",
      "--progress",
      "0",
      "--id",
      "demo/child",
      "--app",
      "test-app",
      "--title",
      "café",
      "--message",
      "a:b;c=d",
      "--terminator",
      "bel",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "\x1b]7501;state=blocked:id=demo/child:kind=question:progress=0:app=test-app:title=Y2Fmw6k=:msg=YTpiO2M9ZA==\x07",
    );
  });

  it.each([
    ["--kind", "auth"],
    ["--hold"],
    ["--progress", "0"],
    ["--state", "done", "--progress", "0"],
    ["--state", "idle", "--kind", "auth"],
    ["--state", "working", "--interval", "1"],
    ["--state", "clear", "--hold"],
    ["--state", "clear", "--title", "No"],
    ["--interval", "0"],
    ["--interval", "-1"],
    ["--interval", "Infinity"],
    ["--state", "unknown"],
    ["--state", "working", "--progress", "101"],
    ["--state", "idle", "--message", "\x1b]0;injected\x07"],
  ])("rejects invalid flags before emitting: %j", (...flags) => {
    const result = run("--force", ...flags);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("\x1b]7501;");
  });

  it("warns only for an explicit terminal-wide clear", () => {
    const root = run("--force", "--state", "clear");
    expect(root.status).toBe(0);
    expect(root.stdout).toBe("\x1b]7501;state=clear\x1b\\");
    expect(root.stderr).toContain("ALL program status records");
    const child = run("--force", "--state", "clear", "--id", "demo");
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("\x1b]7501;state=clear:id=demo\x1b\\");
    expect(child.stderr).not.toContain("ALL program status records");
  });

  it.each(["0.001", "0.0000001"])(
    "runs the tour with interval %s and clears only its subtree",
    (interval) => {
      const result = run("--force", "--interval", interval);
      expect(result.status).toBe(0);
      const sequences = result.stdout.split("\x1b\\").filter(Boolean);
      const reports = sequences.filter((sequence) => sequence.startsWith("\x1b]7501;"));
      const titles = sequences
        .filter((sequence) => sequence.startsWith("\x1b]2;"))
        .map((sequence) => sequence.slice(4));
      expect(titles.slice(0, 5)).toEqual([
        "manifold: Idle",
        "manifold: Working, indeterminate",
        "manifold: Working 0%",
        "manifold: Working 37%",
        "manifold: Working 100%",
      ]);
      expect(titles).toContain("manifold: Waiting for permission 37%");
      expect(titles).toContain("manifold: Waiting for auth 37%");
      expect(titles).toContain("manifold: Clear build subtree, keep sibling");
      expect(titles.at(-1)).toBe("manifold: Done");
      const roots = reports.filter((report) => !report.includes(":id="));
      expect(
        roots.map((report) =>
          Buffer.from(
            report
              .split(":")
              .find((field) => field.startsWith("title="))
              ?.slice(6) ?? "",
            "base64",
          ).toString("utf8"),
        ),
      ).toEqual(titles);
      for (const state of ["idle", "working", "blocked", "done", "error", "clear"]) {
        expect(reports.some((report) => report.startsWith(`\x1b]7501;state=${state}`))).toBe(true);
      }
      for (const kind of ["permission", "question", "auth"]) {
        expect(reports.some((report) => report.includes(`:kind=${kind}:progress=37`))).toBe(true);
        expect(
          reports.some(
            (report) => report.includes(`:kind=${kind}:`) && !report.includes(":progress="),
          ),
        ).toBe(true);
      }
      expect(reports).toContain("\x1b]7501;state=working:id=manifold-status-demo/sibling");
      expect(reports).not.toContain("\x1b]7501;state=clear");
      expect(reports.at(-2)).toBe("\x1b]7501;state=clear:id=manifold-status-demo");
      expect(reports.at(-1)).toBe(
        "\x1b]7501;state=done:app=manifold:title=bWFuaWZvbGQ6IERvbmU=:msg=UHJvZ3JhbSBzdGF0dXMgdG91ciBmaW5pc2hlZA==",
      );
    },
  );

  it("resets a held child on an immediate interrupt without resetting the root", async () => {
    const stdout = await interruptAfter(
      [
        "index.ts",
        "debug",
        "program-status",
        "--force",
        "--state",
        "blocked",
        "--kind",
        "auth",
        "--id",
        "demo/child",
        "--app",
        "manifold",
        "--hold",
      ],
      "Holding until Ctrl-C.",
    );
    expect(stdout).toBe(
      "\x1b]7501;state=blocked:id=demo/child:kind=auth:app=manifold\x1b\\\x1b]7501;state=idle:id=demo/child:app=manifold\x1b\\",
    );
  });

  it("clears tour children and reports root idle on interruption", async () => {
    const stdout = await interruptAfter(
      [
        "index.ts",
        "debug",
        "program-status",
        "--force",
        "--interval",
        "0.02",
        "--terminator",
        "bel",
      ],
      "\x1b]7501;state=working:id=manifold-status-demo/sibling:app=manifold-worker",
    );
    expect(stdout.startsWith("\x1b]2;manifold: Idle\x07")).toBe(true);
    expect(stdout).toContain(
      "\x1b]7501;state=blocked:id=manifold-status-demo/build/approval:kind=permission",
    );
    expect(
      stdout.endsWith(
        "\x1b]7501;state=clear:id=manifold-status-demo\x07\x1b]2;manifold: Cancelled\x07\x1b]7501;state=idle:app=manifold:title=bWFuaWZvbGQ6IENhbmNlbGxlZA==\x07",
      ),
    ).toBe(true);
    expect(stdout).not.toContain("\x1b]7501;state=clear\x07");
  });
});

const statusSource = (source: string) => `
  import { BunRuntime } from '@effect/platform-bun';
  import { Effect, Fiber } from 'effect';
  import { withProgramStatus } from './src/program-status';
  Object.defineProperty(process.stdout, 'isTTY', {value:true});
  process.env.TERM = 'xterm-256color';
  delete process.env.MANIFOLD_PROGRAM_STATUS;
  ${source}
`;

const runStatus = (source: string) =>
  spawnSync("bun", ["-e", statusSource(source)], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    timeout: 10_000,
  });

describe("command program status", () => {
  it("reports phase-local progress and preserves the command result", () => {
    const result = runStatus(`
      const value = await Effect.runPromise(withProgramStatus(status => Effect.sync(() => {
        status.phase('Checking');
        status.progress(0,3);
        status.progress(1,3);
        status.progress(2,3);
        status.progress(3,3);
        status.phase('Finalizing');
        status.summary('2 matched; 1 ambiguous');
        return 42;
      })));
      process.stderr.write(String(value));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("42");
    expect(
      [...result.stdout.matchAll(/\x1b\]2;([^\x1b]*)\x1b\\/gu)].map((match) => match[1]),
    ).toEqual([
      "manifold: Checking",
      "manifold: Checking 0%",
      "manifold: Checking 33%",
      "manifold: Checking 66%",
      "manifold: Checking 100%",
      "manifold: Finalizing",
      "manifold: Done",
    ]);
    const reports = result.stdout
      .split("\x1b\\")
      .filter((sequence) => sequence.startsWith("\x1b]7501;"));
    expect(reports.at(-2)).not.toContain(":progress=");
    expect(reports.at(-1)).toContain("state=done:app=manifold:");
    expect(reports.at(-1)).toContain(
      `:msg=${Buffer.from("2 matched; 1 ambiguous").toString("base64")}`,
    );
  });

  it.each(["rows", "cleanup", "defect"])(
    "retains %s failure without changing command exit behavior",
    (failure) => {
      const result = runStatus(`
      const operation = withProgramStatus(status => Effect.sync(() => {
        status.phase('Checking');
        status.summary('1 matched; 1 error', ${failure === "rows"});
      }).pipe(${failure === "cleanup" ? "Effect.ensuring(Effect.die('cleanup failed'))" : failure === "defect" ? "Effect.andThen(Effect.die('original defect'))" : "Effect.as(42)"}));
      const exit = await Effect.runPromise(Effect.exit(operation));
      if (exit._tag === 'Failure') {
        process.stderr.write(String(exit.cause));
        process.exitCode = 1;
      }
    `);
      expect(result.status).toBe(failure === "rows" ? 0 : 1);
      if (failure !== "rows") {
        expect(result.stderr).toContain(
          failure === "cleanup" ? "cleanup failed" : "original defect",
        );
      }
      expect(result.stdout).toContain("\x1b]7501;state=error:app=manifold:");
      expect(result.stdout).not.toContain("state=done");
      expect(result.stdout).not.toContain("state=idle");
    },
  );

  it("drops invalid metadata without losing the final status", () => {
    const result = runStatus(`
      await Effect.runPromise(withProgramStatus(status => Effect.sync(() => {
        status.phase('Checking');
        status.phase('Invalid\\u001b]2;injected\\u0007');
        status.summary('x'.repeat(2049), true);
      })));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("injected");
    expect(result.stdout).not.toContain(":msg=");
    expect(result.stdout).toContain("\x1b]7501;state=error:app=manifold:");
  });

  it("keeps status write failures from affecting the operation", () => {
    const result = runStatus(`
      import { closeSync } from 'node:fs';
      closeSync(1);
      const value = await Effect.runPromise(withProgramStatus(status => Effect.sync(() => {
        status.phase('Checking');
        status.progress(1,3);
        status.summary('Saved');
        return 42;
      })));
      process.stderr.write(String(value));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("42");
  });

  it("finalizes on an immediate SIGINT with BunRuntime", async () => {
    const stdout = await interruptAfter(
      [
        "-e",
        statusSource(`
      BunRuntime.runMain(withProgramStatus(status => Effect.gen(function*() {
        status.phase('Loading registry');
        yield* Effect.never;
      })), {disableErrorReporting:true});
    `),
      ],
      "\x1b]7501;state=working:app=manifold:",
    );
    expect(stdout).toContain("\x1b]2;manifold: Cancelled\x1b\\");
    expect(stdout.match(/state=idle/g)).toHaveLength(1);
    expect(
      stdout.endsWith("\x1b]7501;state=idle:app=manifold:title=bWFuaWZvbGQ6IENhbmNlbGxlZA==\x1b\\"),
    ).toBe(true);
  });

  it("ignores Promise callbacks after interruption", () => {
    const result = runStatus(`
      let release, ready;
      const started = new Promise(resolve => {ready=resolve});
      const pending = new Promise(resolve => {release=resolve});
      const fiber = Effect.runFork(withProgramStatus(status => Effect.tryPromise({
        try: async () => {
          status.phase('Checking');
          ready();
          await pending;
          status.phase('Too late');
          status.progress(1,1);
          status.summary('Late error', true);
        },
        catch: error => error,
      })));
      await started;
      await Effect.runPromise(Fiber.interrupt(fiber));
      release();
      await pending;
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Too late");
    expect(result.stdout.match(/state=idle/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("state=error");
    expect(result.stdout).not.toContain("progress=100");
  });
});
