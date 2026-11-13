import { requestInitText, type JsonObject } from "@manifold/json";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  drainAniListOpsPass,
  __drainTest,
  type DrainApiClient,
  type PendingAniListOp,
} from "../src/anilist-drain";

const op = (opId: string, kind: string, payload: JsonObject): PendingAniListOp => ({
  opId,
  kind,
  payload,
  attempts: 0,
});

afterEach(() => {
  vi.unstubAllGlobals();
  __drainTest.restoreThrottle();
});

describe("drainAniListOpsPass", () => {
  it("returns zeros when the queue is empty", async () => {
    const api: DrainApiClient = {
      pendingAniListOps: async () => [],
      completeOps: async () => {
        throw new Error("completeOps must not run on empty queue");
      },
    };

    await expect(drainAniListOpsPass(api, "token")).resolves.toEqual({
      fetched: 0,
      ok: 0,
      failed: 0,
      reported: 0,
    });
  });

  it("executes status ops and reports completion", async () => {
    __drainTest.resetThrottle();
    const completed: unknown[] = [];

    const api: DrainApiClient = {
      pendingAniListOps: async () => [
        op("s1", "anilist.status", { anilistId: "42", status: "reading" }),
      ],
      completeOps: async (results) => {
        completed.push(...results);

        return { updated: results.length };
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            SaveMediaListEntry: { id: 9001, status: "CURRENT", private: true },
          },
        }),
      ),
    );

    const summary = await drainAniListOpsPass(api, "token");
    expect(summary).toEqual({ fetched: 1, ok: 1, failed: 0, reported: 1 });
    expect(completed).toEqual([{ opId: "s1", ok: true, mediaListEntryId: 9001 }]);
  });

  it("marks failed ops without aborting the batch", async () => {
    __drainTest.resetThrottle();
    const completed: unknown[] = [];

    const api: DrainApiClient = {
      pendingAniListOps: async () => [
        op("bad", "anilist.status", { anilistId: "not-a-number", status: "reading" }),
        op("ok", "anilist.progress", { anilistId: "7", progress: 3 }),
      ],
      completeOps: async (results) => {
        completed.push(...results);

        return { updated: results.length };
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = requestInitText(init) ?? "";

        if (body.includes("progress")) {
          return Response.json({
            data: {
              SaveMediaListEntry: { id: 1, progress: 3, status: "CURRENT", private: true },
            },
          });
        }

        return Response.json({ data: { SaveMediaListEntry: { id: 1 } } });
      }),
    );

    const summary = await drainAniListOpsPass(api, "token");
    expect(summary.fetched).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.reported).toBe(2);
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ opId: "bad", ok: false });
    expect(completed[1]).toMatchObject({ opId: "ok", ok: true });
  }, 15_000);

  it.each([
    ["answers HTTP 503", async () => new Response("upstream down", { status: 503 })],
    ["rejects the token", async () => new Response("{}", { status: 401 })],
    [
      "cannot be reached",
      async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "stops the pass and leaves the remaining ops pending when AniList %s",
    async (_name, unavailable) => {
      __drainTest.resetThrottle();
      const completed: unknown[] = [];

      const api: DrainApiClient = {
        pendingAniListOps: async () => [
          op("done", "anilist.progress", { anilistId: "7", progress: 3 }),
          op("hit", "anilist.status", { anilistId: "42", status: "reading" }),
          op("after", "anilist.status", { anilistId: "43", status: "reading" }),
        ],
        completeOps: async (results) => {
          completed.push(...results);

          return { updated: results.length };
        },
      };

      let calls = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;

          if (calls === 1) {
            return Response.json({
              data: {
                SaveMediaListEntry: { id: 1, progress: 3, status: "CURRENT", private: true },
              },
            });
          }

          return unavailable();
        }),
      );

      // The API blocks an op after five reported failures. An outage or a
      // rejected token says nothing about the op, so neither the op that hit it
      // nor the one after it may be reported, and the one after is not sent.
      await expect(drainAniListOpsPass(api, "token")).rejects.toThrow(
        /2 of 3 AniList operations stay pending/,
      );
      expect(completed).toEqual([{ opId: "done", ok: true }]);
      expect(calls).toBe(2);
    },
    15_000,
  );

  it("keeps the reason the pass stopped when reporting the finished ops fails too", async () => {
    __drainTest.resetThrottle();

    const api: DrainApiClient = {
      pendingAniListOps: async () => [
        op("done", "anilist.progress", { anilistId: "7", progress: 3 }),
        op("hit", "anilist.status", { anilistId: "42", status: "reading" }),
      ],
      completeOps: async () => {
        throw new Error("api offline");
      },
    };

    let calls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;

        return calls === 1
          ? Response.json({ data: { SaveMediaListEntry: { id: 1, progress: 3 } } })
          : new Response("upstream down", { status: 503 });
      }),
    );

    const failure = drainAniListOpsPass(api, "token");

    await expect(failure).rejects.toThrow(/1 of 2 AniList operations stay pending/);
    await expect(failure).rejects.toThrow(/complete ops failed: .*api offline/);
  }, 15_000);

  /** AniList stub for delete ops: the viewer, their list, and the delete mutation. */
  const stubDeleteFetch = (listEntries: readonly JsonObject[]): string[] => {
    const deleteBodies: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = requestInitText(init) ?? "";

        if (body.includes("Viewer")) {
          return Response.json({ data: { Viewer: { id: 1, name: "reader" } } });
        }

        if (body.includes("MediaListCollection")) {
          return Response.json({
            data: { MediaListCollection: { lists: [{ entries: listEntries }] } },
          });
        }

        if (body.includes("DeleteMediaListEntry")) {
          deleteBodies.push(body);

          return Response.json({ data: { DeleteMediaListEntry: { deleted: true } } });
        }

        return Response.json({ errors: [{ message: "unexpected query" }] }, { status: 400 });
      }),
    );

    return deleteBodies;
  };

  const drainDelete = async (payload: JsonObject) => {
    __drainTest.resetThrottle();
    const completed: unknown[] = [];

    const api: DrainApiClient = {
      pendingAniListOps: async () => [op("d1", "anilist.delete", payload)],
      completeOps: async (results) => {
        completed.push(...results);

        return { updated: results.length };
      },
    };

    const summary = await drainAniListOpsPass(api, "token");

    return { summary, completed };
  };

  it("resolves delete mediaListEntryId from the bulk map when missing", async () => {
    const deleteBodies = stubDeleteFetch([{ id: 777, mediaId: 55 }]);

    const { summary, completed } = await drainDelete({ anilistId: "55" });

    expect(summary).toEqual({ fetched: 1, ok: 1, failed: 0, reported: 1 });
    expect(completed).toEqual([{ opId: "d1", ok: true, mediaListEntryId: 777 }]);
    expect(deleteBodies).toHaveLength(1);
  }, 20_000);

  it("completes a delete whose title is no longer on the list", async () => {
    // A replay after a lost acknowledgement: the payload still carries the id
    // of the entry that the first attempt deleted.
    const deleteBodies = stubDeleteFetch([{ id: 778, mediaId: 56 }]);

    const { summary, completed } = await drainDelete({ anilistId: "55", mediaListEntryId: 777 });

    expect(summary).toEqual({ fetched: 1, ok: 1, failed: 0, reported: 1 });
    expect(completed).toEqual([{ opId: "d1", ok: true }]);
    expect(deleteBodies).toEqual([]);
  }, 20_000);

  it("deletes the entry AniList reports now instead of a stale payload id", async () => {
    const deleteBodies = stubDeleteFetch([{ id: 900, mediaId: 55 }]);

    const { completed } = await drainDelete({ anilistId: "55", mediaListEntryId: 777 });

    expect(completed).toEqual([{ opId: "d1", ok: true, mediaListEntryId: 900 }]);
    expect(deleteBodies).toHaveLength(1);
    expect(deleteBodies[0]).toContain("900");
    expect(deleteBodies[0]).not.toContain("777");
  }, 20_000);
});
