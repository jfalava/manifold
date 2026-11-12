import { expect, test } from "bun:test";

import { beginAniListAuthorize, consumeAniListAuthorize } from "../src/lib/anilist-authorize";

const tabStorage = () => {
  const items = new Map<string, string>();

  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

const MINUTE = 60_000;

test("a tab that never pressed Authorize cannot import a token", () => {
  expect(consumeAniListAuthorize(tabStorage(), 5 * MINUTE)).toBe(false);
});

test("an authorization is accepted once, so replaying the callback link fails", () => {
  const storage = tabStorage();

  beginAniListAuthorize(storage, 5 * MINUTE);

  expect(consumeAniListAuthorize(storage, 6 * MINUTE)).toBe(true);
  expect(consumeAniListAuthorize(storage, 6 * MINUTE)).toBe(false);
});

test("an authorization expires after ten minutes", () => {
  const fresh = tabStorage();
  const stale = tabStorage();

  beginAniListAuthorize(fresh, 0);
  beginAniListAuthorize(stale, 0);

  expect(consumeAniListAuthorize(fresh, 10 * MINUTE)).toBe(true);
  expect(consumeAniListAuthorize(stale, 10 * MINUTE + 1)).toBe(false);
});

test("a mark that is not a past timestamp is rejected", () => {
  const future = tabStorage();
  const junk = tabStorage();

  beginAniListAuthorize(future, 20 * MINUTE);
  junk.setItem("manifold:anilist-authorize-started-at", "soon");

  expect(consumeAniListAuthorize(future, 10 * MINUTE)).toBe(false);
  expect(consumeAniListAuthorize(junk, 10 * MINUTE)).toBe(false);
});
