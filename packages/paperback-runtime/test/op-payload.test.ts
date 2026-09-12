/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics schemaSync:off */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@manifold/json";
import type { PendingSyncOp } from "../src/api.js";
import { parsePendingAniListOp } from "../src/op-payload.js";

const pendingOp = (opId: string, kind: string, payload: JsonObject): PendingSyncOp => ({
  opId,
  kind,
  origin: "admin",
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
});
