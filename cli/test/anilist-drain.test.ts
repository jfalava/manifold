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

  it("resolves delete mediaListEntryId from the bulk map when missing", async () => {
    __drainTest.resetThrottle();
    const completed: unknown[] = [];

    const api: DrainApiClient = {
      pendingAniListOps: async () => [op("d1", "anilist.delete", { anilistId: "55" })],
      completeOps: async (results) => {
        completed.push(...results);

        return { updated: results.length };
      },
    };

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = requestInitText(init) ?? "";

      if (body.includes("Viewer")) {
        return Response.json({ data: { Viewer: { id: 1, name: "reader" } } });
      }

      if (body.includes("MediaListCollection")) {
        return Response.json({
          data: {
            MediaListCollection: {
              lists: [{ entries: [{ id: 777, mediaId: 55 }] }],
            },
          },
        });
      }

      if (body.includes("DeleteMediaListEntry")) {
        return Response.json({ data: { DeleteMediaListEntry: { deleted: true } } });
      }

      return Response.json({ errors: [{ message: "unexpected query" }] }, { status: 400 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const summary = await drainAniListOpsPass(api, "token");
    expect(summary).toEqual({ fetched: 1, ok: 1, failed: 0, reported: 1 });
    expect(completed).toEqual([{ opId: "d1", ok: true, mediaListEntryId: 777 }]);
  }, 20_000);
});
