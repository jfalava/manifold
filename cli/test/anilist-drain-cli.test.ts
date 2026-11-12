import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Run the real command with Bun services, but never use real credentials or HTTP.
const runDrainOnce = (accepted: boolean) =>
  spawnSync(
    "bun",
    [
      "-e",
      `
  import { BunServices } from "@effect/platform-bun";
  import { Effect } from "effect";
  import { Command } from "effect/cli";
  import { opsCommand } from "./src/commands/toolbox";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MANIFOLD_")) delete process.env[key];
  }
  process.env.MANIFOLD_TOKEN = "fake-api-token";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/v1/ops/pending/anilist")) return Response.json({
      ops: [{
        id: 1, opId: "s1", target: "anilist", kind: "anilist.status", origin: "admin",
        payload: { anilistId: "42", status: "reading" }, state: "pending", attempts: 0,
        createdAt: 1, updatedAt: 1,
      }],
    });
    if (url.pathname.endsWith("/v1/ops/complete")) {
      return Response.json({ updated: JSON.parse(init.body).results.length });
    }
    if (url.hostname === "graphql.anilist.co") return ${
      accepted
        ? 'Response.json({ data: { SaveMediaListEntry: { id: 9001, status: "CURRENT", private: true } } })'
        : 'Response.json({ errors: [{ message: "Not Found.", status: 404 }], data: null }, { status: 404 })'
    };
    throw new Error("Unexpected request " + url);
  };
  try {
    await Effect.runPromise(Command.runWith(opsCommand, { version: "test" })(["drain-anilist", "--once", "--anilist-token", "fake-anilist-token"]).pipe(
      Effect.provide(BunServices.layer),
    ));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
`,
    ],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 30_000 },
  );

describe("ops drain-anilist --once exit status", () => {
  it("exits 0 when every op was applied", () => {
    const result = runDrainOnce(true);
    expect(result.stdout).toContain("fetched=1 ok=1 failed=0 reported=1");
    expect(result.status).toBe(0);
  }, 40_000);

  it("fails when an op was refused, instead of reporting a completed drain", () => {
    const result = runDrainOnce(false);
    expect(result.stdout).toContain("fetched=1 ok=0 failed=1 reported=1");
    expect(result.stderr).toContain("1 of 1 AniList operations failed");
    expect(result.status).toBe(1);
  }, 40_000);
});
