import { expect, it } from "vitest";
import { normalizeTitle, uniqueTitles } from "../src/title-normalization";

it("normalizes case and punctuation while deduplicating trimmed search aliases", () => {
  expect(normalizeTitle(" My Neighbor Furi-san! ")).toBe("my neighbor furi san");
  expect(uniqueTitles([" Furi-san ", "furi san", "", "!!!", "Another Title"])).toEqual([
    "Furi-san",
    "Another Title",
  ]);
});
