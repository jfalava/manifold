import { describe, expect, it } from "vitest";

import { normalizeTitle, selectTitleMatch } from "../src/migration";

const manga = (id: string, title: string) => ({ id, title });

describe("AniList to MangaDex title matching", () => {
  it("prefers an exact title over an earlier result that only starts with it", () => {
    expect(
      selectTitleMatch(
        [manga("gluttony", "Berserk of Gluttony"), manga("berserk", "Berserk")],
        normalizeTitle("Berserk"),
      ),
    ).toEqual({ manga: manga("berserk", "Berserk"), method: "title-exact" });
  });

  it("accepts a longer title only when it is the sole one starting with the target", () => {
    expect(
      selectTitleMatch(
        [manga("other", "Vinland Saga"), manga("gluttony", "Berserk of Gluttony")],
        normalizeTitle("Berserk"),
      ),
    ).toEqual({ manga: manga("gluttony", "Berserk of Gluttony"), method: "title-prefix" });

    expect(
      selectTitleMatch(
        [manga("gluttony", "Berserk of Gluttony"), manga("guide", "Berserk Official Guidebook")],
        normalizeTitle("Berserk"),
      ),
    ).toBeUndefined();
  });

  it("matches nothing for a title that normalizes to an empty string", () => {
    expect(normalizeTitle("♡♡♡")).toBe("");
    expect(selectTitleMatch([manga("first", "Anything")], normalizeTitle("♡♡♡"))).toBeUndefined();
  });
});
