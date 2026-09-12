/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Run the real command with Bun services, but never use real credentials or HTTP.
const runWipe = (flags: string[], connected: boolean) =>
  spawnSync(
    "bun",
    [
      "-e",
      `
  import { BunServices } from "@effect/platform-bun";
  import { Effect } from "effect";
  import { Command } from "effect/unstable/cli";
  import { wipeMalMangaCommand } from "./src/commands/mal/wipe-manga";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MANIFOLD_")) delete process.env[key];
  }
  process.env.MANIFOLD_TOKEN = "fake-api-token";
  process.env.MANIFOLD_MAL_TOKEN = "fake-mal-token";
  let deleted = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    console.log("MOCK", init.method, url.pathname);
    if (url.pathname.endsWith("/auth/mal")) return Response.json({ provider: "mal", connected: ${connected} });
    if (url.pathname === "/v2/users/@me") return Response.json({ id: 7, name: "reader" });
    if (url.pathname.endsWith("/mangalist")) return Response.json({
      data: deleted ? [] : [{ node: { id: 1, title: "Manga" } }], paging: {},
    });
    if (url.pathname === "/v2/manga/1/my_list_status" && init.method === "DELETE") {
      deleted = true;
      return new Response(null);
    }
    throw new Error("Unexpected request");
  };
  try {
    await Effect.runPromise(Command.runWith(wipeMalMangaCommand, { version: "test" })(${JSON.stringify(flags)}).pipe(
      Effect.provide(BunServices.layer),
    ));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
`,
    ],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 15_000 },
  );

describe("MAL CLI safeguards", () => {
  it("defaults to a dry run", () => {
    const result = runWipe([], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry run: reader (7), 1 manga entries would be deleted");
    expect(result.stdout).not.toContain("MOCK DELETE");
  });

  it("refuses --apply without acknowledging other writers", () => {
    const result = runWipe(["--apply"], false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--backup-paused");
    expect(result.stdout).not.toContain("MOCK");
  });

  it("refuses a still-connected backup even with all apply flags", () => {
    const result = runWipe(["--apply", "--backup-paused"], true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still connected to MAL");
    expect(result.stdout).not.toContain("MOCK DELETE");
    expect(result.stdout).not.toContain("/v2/");
  });

  it("applies without an interactive prompt and verifies the result", () => {
    const result = runWipe(["--apply", "--backup-paused"], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MOCK DELETE /v2/manga/1/my_list_status");
    expect(result.stdout).toContain("verified empty. Anime untouched.");
    expect(result.stdout).not.toContain("yes/no");
    expect(result.stdout).not.toContain("/anime/");
  }, 15_000);
});
