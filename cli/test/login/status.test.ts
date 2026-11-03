import { afterEach, describe, expect, it } from "vitest";

import { loadLoginStatus } from "../../src/login/status";

const NOW = Date.UTC(2026, 10, 3);
const DAY = 86_400_000;

const store =
  (entries: Record<string, string>) =>
  async (ref: { service: string; name: string }): Promise<string | null> =>
    entries[ref.name] ?? null;

afterEach(() => {
  delete process.env.MANIFOLD_TOKEN;
  delete process.env.MANIFOLD_ANILIST_TOKEN;
  delete process.env.MANIFOLD_MAL_TOKEN;
});

describe("login status", () => {
  it("reports env overrides, refresh-on-use sessions and AniList expiry", async () => {
    process.env.MANIFOLD_TOKEN = "env-token";

    const statuses = await loadLoginStatus(
      store({
        "manifold-session": JSON.stringify({
          accessToken: "a",
          refreshToken: "r",
          expiresAt: NOW + DAY,
        }),
        "anilist-session": JSON.stringify({ accessToken: "a", expiresAt: NOW - DAY }),
        // An expired access token with a refresh token still works: the client refreshes on use.
        "mal-session": JSON.stringify({
          clientId: "c",
          accessToken: "a",
          refreshToken: "r",
          expiresAt: NOW - DAY,
        }),
      }),
      NOW,
    );

    expect(statuses.map(({ provider, state }) => [provider, state])).toEqual([
      ["manifold", { kind: "env", variable: "MANIFOLD_TOKEN" }],
      ["anilist", { kind: "expired", at: NOW - DAY }],
      ["mal", { kind: "renews" }],
    ]);
  });

  it("reports missing, unreadable and still-valid sessions", async () => {
    const statuses = await loadLoginStatus(
      store({
        "manifold-session": "not json",
        "anilist-session": JSON.stringify({ accessToken: "a", expiresAt: NOW + 300 * DAY }),
      }),
      NOW,
    );

    expect(statuses.map(({ state }) => state)).toEqual([
      { kind: "invalid" },
      { kind: "expires", at: NOW + 300 * DAY },
      { kind: "missing" },
    ]);
  });
});
