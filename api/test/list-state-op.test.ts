import { describe, expect, it } from "vitest";
import { createAniListListStateOpPayload } from "../src/list-state-op";

describe("createAniListListStateOpPayload", () => {
  it("preserves explicit clears, except a status AniList cannot clear", () => {
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
