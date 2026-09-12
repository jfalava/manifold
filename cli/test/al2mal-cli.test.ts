/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics schemaSync:off */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Real Effect CLI path with mocked fetch — no live AniList/MAL credentials.
const runImport = (flags: string[], connected: boolean) =>
  spawnSync(
    "bun",
    [
      "-e",
      `
  import { BunServices } from "@effect/platform-bun";
  import { Effect } from "effect";
  import { Command } from "effect/unstable/cli";
  import { al2malCommand } from "./src/commands/al2mal";
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MANIFOLD_")) delete process.env[key];
  }
  process.env.MANIFOLD_TOKEN = "fake-api-token";
  process.env.MANIFOLD_ANILIST_TOKEN = "fake-anilist-token";
  process.env.MANIFOLD_MAL_TOKEN = "fake-mal-token";
  process.env.MANIFOLD_MAL_CLIENT_ID = "fake-mal-client";
  let patches = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    console.log("MOCK", method, url.pathname + url.search);
    if (url.pathname.endsWith("/auth/mal")) {
      return Response.json({ provider: "mal", connected: ${connected} });
    }
    if (url.hostname === "graphql.anilist.co") {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (String(body.query).includes("Viewer")) {
        return Response.json({ data: { Viewer: { id: 42 } } });
      }
      return Response.json({
        data: {
          MediaListCollection: {
            lists: [{
              entries: [{
                mediaId: 100,
                status: "CURRENT",
                progress: 5,
                media: {
                  idMal: 777,
                  title: { english: "Test Manga", romaji: "Test Manga" },
                  synonyms: [],
                },
              }],
            }],
          },
        },
      });
    }
    if (url.pathname === "/v2/manga/777/my_list_status" && method === "PATCH") {
      patches += 1;
      console.log("MOCK BODY", String(init.body));
      return Response.json({ status: "reading" });
    }
    if (url.hostname === "api.myanimelist.net" && url.pathname === "/v2/manga") {
      return Response.json({ data: [] });
    }
    throw new Error("Unexpected request " + method + " " + url.href);
  };
  try {
    await Effect.runPromise(Command.runWith(al2malCommand, { version: "test" })(${JSON.stringify(flags)}).pipe(
      Effect.provide(BunServices.layer),
    ));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
`,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 20_000,
    },
  );

describe("anilist-to-mal CLI safeguards", () => {
  it("defaults to a dry run and never PATCHes", () => {
    const result = runImport([], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).not.toContain("MOCK PATCH");
    expect(result.stdout).toContain("mal:777");
  }, 20_000);

  it("refuses --apply without --backup-paused", () => {
    const result = runImport(["--apply"], false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--backup-paused");
    expect(result.stdout).not.toContain("MOCK PATCH");
  });

  it("refuses a still-connected backup even with all apply flags", () => {
    const result = runImport(["--apply", "--backup-paused"], true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("still connected to MAL");
    expect(result.stdout).not.toContain("MOCK PATCH");
  });

  it("applies status and chapter progress when writers are paused", () => {
    const result = runImport(["--apply", "--backup-paused"], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MOCK PATCH /v2/manga/777/my_list_status");
    expect(result.stdout).toContain("num_chapters_read=5");
    expect(result.stdout).toContain("status=reading");
    expect(result.stdout).toContain("import finished");
  }, 20_000);
});
