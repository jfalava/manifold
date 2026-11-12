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
