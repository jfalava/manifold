import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Run the real command with Bun services, but never use real credentials or HTTP.
const runWipe = (deleted: boolean) =>
  spawnSync(
    "bun",
    [
      "-e",
      `
  import { BunServices } from "@effect/platform-bun";
  import { Effect } from "effect";
  import { Command } from "effect/cli";
  import { wipeAlMangaCommand } from "./src/commands/anilist/wipe-manga";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MANIFOLD_")) delete process.env[key];
  }
  globalThis.fetch = async (input, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes("Viewer")) return Response.json({ data: { Viewer: { id: 7, name: "reader" } } });
    if (query.includes("MediaListCollection")) return Response.json({
      data: { MediaListCollection: { lists: [{ entries: [{ id: 11, media: { id: 1, title: { romaji: "Manga" } } }] }] } },
    });
    if (query.includes("activities")) return Response.json({
      data: { Page: { pageInfo: { hasNextPage: false }, activities: [] } },
    });
    if (query.includes("DeleteMediaListEntry")) return Response.json({
      data: { DeleteMediaListEntry: { deleted: ${deleted} } },
    });
    throw new Error("Unexpected request");
  };
  try {
    await Effect.runPromise(Command.runWith(wipeAlMangaCommand, { version: "test" })(["--apply", "--yes", "--anilist-token", "fake-anilist-token"]).pipe(
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

describe("AniList wipe exit status", () => {
  it("reports a completed wipe when every delete succeeded", () => {
    const result = runWipe(true);
    expect(result.stdout).toContain("Wipe complete.");
    expect(result.status).toBe(0);
  }, 40_000);

  it("fails when AniList refused a delete, instead of reporting a completed wipe", () => {
    const result = runWipe(false);
    expect(result.stderr).toContain("Wipe incomplete: 1 deletes failed");
    expect(result.stdout).not.toContain("Wipe complete.");
    expect(result.status).toBe(1);
  }, 40_000);
});
