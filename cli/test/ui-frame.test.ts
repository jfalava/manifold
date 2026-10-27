import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";

import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";

import { createRun, makePhaseReporter, wrapFrameText } from "../src/ui";

describe("wrapFrameText", () => {
  it("returns a single empty line for empty input", () => {
    expect(wrapFrameText("", 40)).toEqual([""]);
  });

  it("splits long URLs so each chunk fits the rail content width", () => {
    const url =
      "https://anilist.co/api/v2/oauth/authorize?client_id=49218&redirect_uri=http%3A%2F%2F127.0.0.1%3A8767%2Fcallback&response_type=code&state=7b536466-4338-4cb7-9c72-83edb45d420c";
    const chunks = wrapFrameText(url, 40);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.join("")).toBe(url);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("hierarchical terminal output", () => {
  it.each([
    [34, false],
    [80, false],
    [140, false],
    [80, true],
  ] as const)(
    "replaces statuses at %i columns with cursor-line reflow=%s",
    async (columns, reflowCursorLine) => {
      vi.stubEnv("TERM", "xterm-256color");
      const terminal = new Terminal({
        cols: columns,
        rows: 24,
        scrollback: 100,
        allowProposedApi: true,
        reflowCursorLine,
      });
      let raw = "";
      const stream = Object.assign(
        new Writable({
          write(chunk, _encoding, callback) {
            raw += String(chunk);
            terminal.write(String(chunk));
            callback();
          },
        }),
        { isTTY: true, columns, rows: 24 },
      );
      const read = async () => {
        await new Promise<void>((resolve) => terminal.write("", resolve));
        return Array.from({ length: terminal.buffer.active.length }, (_, index) =>
          terminal.buffer.active.getLine(index)!.translateToString(true),
        ).filter(Boolean);
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 230));
      const reports: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        reports.push(String(chunk));
        terminal.write(String(chunk).replace(/\n/g, "\r\n"));
        return true;
      });
      try {
        await createRun(
          [
            {
              title: "Disabled",
              enabled: false,
              task: () => {
                throw new Error("must not run");
              },
            },
            {
              title: "Search catalog",
              task: async (_ctx, task) => {
                const reporter = makePhaseReporter(task);
                reporter.item("35/104 日本語 · " + "Long title ".repeat(20));
                reporter.detail("/search/story/" + "long_url_".repeat(20));
                reporter.progress(34, 104);
                await tick();
                let lines = await read();
                expect(lines.filter((line) => line.includes("Search catalog"))).toHaveLength(1);
                expect(lines[1]).toMatch(/^ {4}󰌗 35\/104/);
                expect(lines[2]).toMatch(/^ {8}󰒓 \/search/);
                expect(terminal.buffer.active.baseY).toBe(0);

                for (let index = 0; index < 200; index++) reporter.detail(`Old status ${index}`);
                reporter.detail("PAUSED · solve in Chrome · Enter retries");
                await tick();
                lines = await read();
                expect(lines.filter((line) => line.includes("Search catalog"))).toHaveLength(1);
                expect(lines.some((line) => line.includes("PAUSED"))).toBe(true);
                expect(lines.join("\n")).not.toContain("Old status");
                expect(terminal.buffer.active.baseY).toBe(0);

                reporter.detail("Retrying request");
                await tick();
                lines = await read();
                expect(lines.join("\n")).not.toContain("PAUSED");
                expect(lines.filter((line) => line.includes("Search catalog"))).toHaveLength(1);

                reporter.note("SELECTION sample-entry");
                reporter.progress(40, 104);
                await tick();
                lines = await read();
                expect(lines.filter((line) => line.includes("SELECTION"))).toHaveLength(1);
                expect(lines.filter((line) => line.includes("Search catalog"))).toHaveLength(1);
                if (columns === 80) {
                  // At 35 columns, these wide graphemes need three rows, not ceil(70/35).
                  reporter.item("界".repeat(32));
                  reporter.detail("Retrying request");
                  await tick();
                  for (const width of [35, 140, 34, 80]) {
                    terminal.resize(width, 24);
                    stream.columns = width;
                    const before = await read();
                    const cursor = terminal.buffer.active.cursorY;
                    stream.emit("resize");
                    await tick();
                    lines = await read();
                    expect(
                      lines.filter((line) => line.includes("SELECTION")),
                      `${width} cursor=${cursor} before=${before.join("\n")} after=${lines.join("\n")}`,
                    ).toHaveLength(1);
                    expect(lines.filter((line) => line.includes("Search catalog"))).toHaveLength(1);
                    expect(lines.filter((line) => line.startsWith("    󰌗"))).toHaveLength(1);
                    expect(lines.filter((line) => line.startsWith("        󰒓"))).toHaveLength(1);
                    expect(terminal.buffer.active.baseY).toBe(0);
                  }
                }
              },
            },
            {
              title: "Push entries",
              task: (_ctx, task) =>
                task.newListr([
                  {
                    title: "Read markers",
                    task: async (_ctx, child) => {
                      makePhaseReporter(child).detail("GET /read");
                      await tick();
                      const lines = await read();
                      expect(lines.some((line) => /^ {4}󰌗 Read markers/.test(line))).toBe(true);
                      expect(lines.some((line) => /^ {8}󰒓 GET/.test(line))).toBe(true);
                      expect(lines.join("\n")).not.toContain("Search catalog");
                    },
                  },
                ]),
            },
            // This stream has precisely the write/dimension capabilities used by cli-progress.
          ],
          { stream: stream as NodeJS.WriteStream },
        ).run();
        expect((await read()).join("\n")).toContain("SELECTION");
        expect((await read()).join("\n")).not.toContain("Push entries");
        expect(reports.join("").match(/SELECTION/g)).toHaveLength(1);
        expect(raw).toContain("\x1b[?25h");
        expect(raw).toContain("\x1b[?7h");
      } finally {
        stdout.mockRestore();
        vi.unstubAllEnvs();
        terminal.dispose();
        stream.destroy();
      }
    },
  );

  it("keeps reports on stdout and suppresses transient updates when redirected", () => {
    const result = spawnSync("bun", ["index.ts", "debug", "ui", "--interval", "0.001"], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SELECTION sample-entry");
    expect(result.stdout).not.toContain("\x1b");
    expect(result.stderr).not.toContain("\x1b");
    expect(result.stderr.match(/Search MangaNato/g)).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain("Searching catalog · update");
  });
});
