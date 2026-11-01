import { expect, it } from "vitest";
import { chapterCoverage, mostCovered } from "../src/chapter-coverage";

const candidate = (id: string, numbers: readonly number[]) => ({
  id,
  coverage: chapterCoverage(numbers.map((chapter) => ({ chapter }))),
});

it("rejects a larger inventory that loses a competitor's chapter positions", () => {
  const larger = candidate("larger", [1, 2, 3, 4]);
  const subset = candidate("subset", [1, 3]);
  const competing = candidate("competing", [2, 5]);

  expect(mostCovered([larger, subset, competing])).toEqual([]);
});

it("rejects equal chapter counts with different positions", () => {
  const first = candidate("first", [1, 2, 4]);
  const second = candidate("second", [1, 3, 4]);

  expect(mostCovered([first, second])).toEqual([]);
});

it("selects a true superset of every competitor", () => {
  const superset = candidate("superset", [1, 2, 3, 4, 5]);
  const first = candidate("first", [1, 4]);
  const second = candidate("second", [2, 3, 5]);

  expect(mostCovered([first, superset, second])).toEqual([superset]);
});

it("preserves identical inventories as ordered ties", () => {
  const first = candidate("first", [1, 2, 4]);
  const subset = candidate("subset", [2, 4]);
  const second = candidate("second", [4, 1, 2, 2]);

  expect(mostCovered([first, subset, second])).toEqual([first, second]);
});
