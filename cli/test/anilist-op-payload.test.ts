import { describe, expect, it } from "vitest";
import type { JsonObject } from "@manifold/json";

import {
  parsePendingAniListOp,
  toAniListGraphqlStatus,
  type PendingAniListOp,
} from "../src/anilist-op-payload";

const pendingOp = (opId: string, kind: string, payload: JsonObject): PendingAniListOp => ({
  opId,
  kind,
  payload,
  attempts: 0,
});

describe("parsePendingAniListOp", () => {
  it.each([
    pendingOp("bad-status", "anilist.status", {
      anilistId: "42",
      status: "CURRENT",
    }),
    pendingOp("missing-progress", "anilist.progress", {
      anilistId: "42",
    }),
    pendingOp("bad-entry-id", "anilist.delete", {
      anilistId: "42",
      mediaListEntryId: 1.5,
    }),
  ])("rejects malformed operation $opId", (op) => {
    expect(() => parsePendingAniListOp(op)).toThrow(`op ${op.opId}`);
  });

  it("preserves explicit nulls in validated field operations", () => {
    expect(
      parsePendingAniListOp(
        pendingOp("clear-fields", "anilist.fields", {
          anilistId: "42",
          status: null,
          notes: null,
          startedAt: null,
        }),
      ),
    ).toEqual({
      kind: "anilist.fields",
      opId: "clear-fields",
      anilistId: "42",
      change: {
        status: null,
        notes: null,
        startedAt: null,
      },
    });
  });

  it("maps registry status ops", () => {
    expect(
      parsePendingAniListOp(
        pendingOp("status-ok", "anilist.status", {
          anilistId: "99",
          status: "reading",
        }),
      ),
    ).toEqual({
      kind: "anilist.status",
      opId: "status-ok",
      anilistId: "99",
      status: "reading",
    });
  });
});

describe("toAniListGraphqlStatus", () => {
  it("maps registry vocabulary to AniList enums", () => {
    expect(toAniListGraphqlStatus("reading")).toBe("CURRENT");
    expect(toAniListGraphqlStatus("on_hold")).toBe("PAUSED");
    expect(toAniListGraphqlStatus("plan_to_read")).toBe("PLANNING");
    expect(toAniListGraphqlStatus("re_reading")).toBe("REPEATING");
    expect(toAniListGraphqlStatus("completed")).toBe("COMPLETED");
    expect(toAniListGraphqlStatus("dropped")).toBe("DROPPED");
  });
});
