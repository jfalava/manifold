import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestInitText } from "@manifold/json";
import { afterEach, describe, expect, it } from "vitest";

import { createMangaDexTokenManager } from "../src/mangadex-token";

describe("createMangaDexTokenManager", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signs in again after a cached access token without a refresh token is rejected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manifold-md-token-"));
    directories.push(directory);
    const cachePath = join(directory, "token.json");
    const grants: string[] = [];

    writeFileSync(
      cachePath,
      JSON.stringify({ accessToken: "cached", expiresAt: Date.now() + 600_000 }),
      { mode: 0o644 },
    );

    const manager = createMangaDexTokenManager({
      credentials: { clientId: "id", clientSecret: "secret", username: "user", password: "pass" },
      cachePath,
      fetcher: async (_input, init) => {
        grants.push(new URLSearchParams(requestInitText(init) ?? "").get("grant_type") ?? "");

        return Response.json({ access_token: "fresh", refresh_token: "refresh", expires_in: 900 });
      },
    });

    await expect(manager.current()).resolves.toBe("cached");
    expect(grants).toEqual([]);

    manager.invalidate();

    await expect(manager.current()).resolves.toBe("fresh");
    expect(grants).toEqual(["password"]);
    // The rewritten cache is private even though the file existed with a wider mode.
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
      accessToken: "fresh",
      refreshToken: "refresh",
    });
  });
});
