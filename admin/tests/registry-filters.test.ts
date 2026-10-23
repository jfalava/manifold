import { expect, test } from "bun:test";

import type { RegistryListEntry } from "@manifold/contract";

import { EMPTY_REGISTRY_FILTERS, matchesRegistryFilters } from "../src/lib/registry-filters";

const base: RegistryListEntry = {
  id: "entry-orbit",
  title: "The Long Journey",
  provider: "anilist",
  providerId: "42",
  createdAt: 0,
  updatedAt: 0,
  providers: [{ provider: "anilist", externalId: "AL-42", updatedAt: 0 }],
  state: { entryId: "entry-orbit", status: "reading", updatedAt: 0 },
};

test("status alternatives are ORed, but text and all binding conditions are ANDed", () => {
  const entries: RegistryListEntry[] = [
    base,
    { ...base, id: "hold", state: { ...base.state!, status: "on_hold" } },
    { ...base, id: "completed", state: { ...base.state!, status: "completed" } },
    { ...base, id: "no-anilist", providers: [] },
    {
      ...base,
      id: "has-mal",
      providers: [...base.providers, { provider: "mal", externalId: "7", updatedAt: 0 }],
    },
    {
      ...base,
      id: "has-mangadex",
      providers: [...base.providers, { provider: "mangadex", externalId: "md-5", updatedAt: 0 }],
    },
    { ...base, id: "wrong-text", title: "Another Story" },
    { ...base, id: "tombstone", tombstoned: true },
  ];
  const filters = {
    text: " JOURNEY ",
    statuses: ["reading", "on_hold"],
    bindings: [
      { provider: "anilist", present: true },
      { provider: "mal", present: false },
      { provider: "mangadex", present: false },
    ],
    unlinked: false,
  };
  expect(
    entries.filter((entry) => matchesRegistryFilters(entry, filters)).map((entry) => entry.id),
  ).toEqual(["entry-orbit", "hold"]);
  expect(entries.filter((entry) => matchesRegistryFilters(entry, EMPTY_REGISTRY_FILTERS))).toEqual(
    entries,
  );
});

test("no list status, tombstoned, and no bindings are distinct conditions", () => {
  const noStatus = { ...base, state: undefined };
  const noBindings = { ...base, providers: [] };
  expect(matchesRegistryFilters(noStatus, { ...EMPTY_REGISTRY_FILTERS, statuses: ["unset"] })).toBe(
    true,
  );
  expect(
    matchesRegistryFilters(noBindings, { ...EMPTY_REGISTRY_FILTERS, statuses: ["unset"] }),
  ).toBe(false);
  expect(matchesRegistryFilters(noStatus, { ...EMPTY_REGISTRY_FILTERS, unlinked: true })).toBe(
    false,
  );
  expect(matchesRegistryFilters(noBindings, { ...EMPTY_REGISTRY_FILTERS, unlinked: true })).toBe(
    true,
  );
  expect(
    matchesRegistryFilters(
      { ...base, tombstoned: true },
      { ...EMPTY_REGISTRY_FILTERS, statuses: ["tombstoned"] },
    ),
  ).toBe(true);
  expect(
    matchesRegistryFilters(
      { ...base, providers: [{ provider: "xcomic", externalId: "source-9", updatedAt: 0 }] },
      { ...EMPTY_REGISTRY_FILTERS, unlinked: true },
    ),
  ).toBe(false);
});

test("search retains title, entry ID, external ID, and source-name matching", () => {
  const entry = { ...base, providers: [{ ...base.providers[0]!, sourceName: "Archive North" }] };
  for (const text of ["long JOURNEY", "ENTRY-orbit", "al-42", "ARCHIVE north"]) {
    expect(matchesRegistryFilters(entry, { ...EMPTY_REGISTRY_FILTERS, text })).toBe(true);
  }
  expect(matchesRegistryFilters(entry, { ...EMPTY_REGISTRY_FILTERS, text: "not here" })).toBe(
    false,
  );
});
