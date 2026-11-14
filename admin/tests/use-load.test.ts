import { expect, test } from "bun:test";

import { createLatestGuard } from "../src/lib/use-load";

test("a load that started earlier stops being current once a later one starts", () => {
  const begin = createLatestGuard();
  const first = begin();

  expect(first()).toBe(true);

  const second = begin();

  // The slow first response must not overwrite what the second one shows.
  expect(first()).toBe(false);
  expect(second()).toBe(true);

  // Guards are per page: another page's loads do not retire this one's.
  createLatestGuard()();
  expect(second()).toBe(true);
});
