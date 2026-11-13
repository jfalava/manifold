import { expect, test } from "bun:test";

import type { MangaDexLibraryItem } from "../src/lib/mangadex";
import {
  mergeMangaDexStatusShelf,
  patchMangaDexLibraryEntry,
  replaceMangaDexLibraryCache,
} from "../src/lib/mangadex-idb";

// bun has no IndexedDB, which is what the page sees in private browsing or
// with storage blocked: every case below runs without the local cache.
const item = (mangaDexId: string, status: string, title?: string): MangaDexLibraryItem => ({
  mangaDexId,
  status,
  entryId: null,
  ...(title !== undefined && { title }),
});

test("this runtime has no IndexedDB", () => {
  expect("indexedDB" in globalThis).toBe(false);
});

test("without IndexedDB a full refresh reports no snapshot instead of failing", async () => {
  expect(await replaceMangaDexLibraryCache([item("a", "reading")])).toBeUndefined();
});

test("without IndexedDB a shelf refetch merges into the library already on the page", async () => {
  const current = [
    item("a", "reading", "Old title"),
    item("b", "reading"),
    item("c", "completed"),
    item("d", ""),
  ];

  const shelf = [item("a", "reading", "New title"), item("d", "reading"), item("e", "reading")];

  const merged = await mergeMangaDexStatusShelf("reading", shelf, current);

  expect(merged.meta).toBeUndefined();
  expect(merged.items).toEqual([
    item("a", "reading", "New title"),
    // On the shelf before, gone from it now: cleared until a full refresh says where it went.
    item("b", ""),
    item("c", "completed"),
    item("d", "reading"),
    item("e", "reading"),
  ]);
});

test("without IndexedDB a status edit's cache write does not reject", async () => {
  expect(await patchMangaDexLibraryEntry("a", { status: "completed" })).toBeUndefined();
});
