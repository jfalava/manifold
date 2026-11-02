import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { createMangaDexClient, MangaDexSourceError } from "@manifold/mangadex";

import { runMangaDexWrites, type MangaDexSession } from "../src/mangadex-session";
import type { PhaseReporter } from "../src/ui";

const fakeSession = (): MangaDexSession & { readonly refreshes: () => number } => {
  const client = createMangaDexClient({ accessToken: "token" });
  let refreshes = 0;

  return {
    client: () => client,
    refresh: async () => {
      refreshes += 1;
    },
    refreshes: () => refreshes,
  };
};

const fakeReporter = () => {
  const notes: string[] = [];
  const problems: string[] = [];

  const reporter: PhaseReporter = {
    detail: () => undefined,
    note: (text) => notes.push(text),
    problem: (text) => problems.push(text),
    progress: () => undefined,
  };

  return { reporter, notes, problems };
};

afterEach(() => {
  process.exitCode = undefined;
});

describe("runMangaDexWrites", () => {
  test("retries a 401 once after refreshing, and never retries other failures", async () => {
    const session = fakeSession();
    const { reporter, notes, problems } = fakeReporter();
    const attempts: string[] = [];

    // expired: 401 then success · revoked: 401 twice · gone: 500, not retried
    const responses = new Map([
      ["ok", [200]],
      ["expired", [401, 200]],
      ["revoked", [401, 401]],
      ["gone", [500]],
    ]);

    await runMangaDexWrites(session, reporter, {
      ids: ["ok", "expired", "revoked", "gone"],
      titles: { revoked: "Revoked Title" },
      write: (_client, mangaId) => {
        attempts.push(mangaId);
        const status = responses.get(mangaId)?.shift() ?? 200;

        return status === 200
          ? Effect.void
          : Effect.fail(new MangaDexSourceError({ message: `HTTP ${status}`, status }));
      },
      verb: "updated",
      spacingMs: 0,
      listWritten: false,
    });

    expect(attempts).toEqual(["ok", "expired", "expired", "revoked", "revoked", "gone"]);
    // One refresh before the batch, then one per 401.
    expect(session.refreshes()).toBe(3);
    expect(problems).toEqual(["Revoked Title: HTTP 401", "gone: HTTP 500"]);
    expect(notes).toEqual(["2/4 updated."]);
    expect(process.exitCode).toBe(1);
  });
});
