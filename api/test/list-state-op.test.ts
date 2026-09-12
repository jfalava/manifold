/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { describe, expect, it } from "vitest";
import { createAniListListStateOpPayload } from "../src/list-state-op";

describe("createAniListListStateOpPayload", () => {
  it("preserves explicit clears for the device-bound AniList mutation", () => {
    expect(
      createAniListListStateOpPayload("entry", "42", 7, {
        status: null,
        score: null,
        notes: null,
        startedAt: null,
        completedAt: null,
        volumeProgress: null,
      }),
    ).toEqual({
      entryId: "entry",
      anilistId: "42",
      mediaListEntryId: 7,
      status: null,
      score: null,
      notes: null,
      startedAt: null,
      completedAt: null,
      volumeProgress: null,
    });
  });

  it("omits unchanged optional fields", () => {
    expect(
      createAniListListStateOpPayload("entry", "42", undefined, {
        notes: "keep this",
      }),
    ).toEqual({
      entryId: "entry",
      anilistId: "42",
      notes: "keep this",
    });
  });
});
