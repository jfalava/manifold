import type { RegistryListEntry } from "@manifold/contract";

export const REGISTRY_STATUSES = [
  "reading",
  "on_hold",
  "plan_to_read",
  "dropped",
  "re_reading",
  "completed",
] as const;

export const REGISTRY_PROVIDERS = [
  "anilist",
  "mal",
  "mangadex",
  "kagane",
  "manganato",
  "xcomic",
] as const;

const LABELS: ReadonlyMap<string, string> = new Map([
  ["reading", "Reading"],
  ["on_hold", "On hold"],
  ["plan_to_read", "Plan to read"],
  ["dropped", "Dropped"],
  ["re_reading", "Re-reading"],
  ["completed", "Completed"],
  ["tombstoned", "Tombstoned"],
  ["unset", "No list status"],
  ["anilist", "AniList"],
  ["mal", "MAL"],
  ["mangadex", "MangaDex"],
  ["kagane", "Kagane"],
  ["manganato", "MangaNato"],
  ["xcomic", "XComic"],
]);

export function registryFilterLabel(value: string): string {
  return LABELS.get(value) ?? value;
}

export type BindingFilter = {
  readonly provider: string;
  readonly present: boolean;
};

export type RegistryFilters = {
  readonly text: string;
  readonly statuses: readonly string[];
  readonly bindings: readonly BindingFilter[];
  readonly unlinked: boolean;
};

export const EMPTY_REGISTRY_FILTERS: RegistryFilters = {
  text: "",
  statuses: [],
  bindings: [],
  unlinked: false,
};

/** OR within the status clause; AND across text and every binding clause. */
export function matchesRegistryFilters(
  entry: RegistryListEntry,
  filters: RegistryFilters,
): boolean {
  const status = entry.tombstoned === true ? "tombstoned" : (entry.state?.status ?? "unset");
  if (filters.statuses.length > 0 && !filters.statuses.includes(status)) {
    return false;
  }
  if (filters.unlinked && entry.providers.length !== 0) {
    return false;
  }
  if (
    !filters.bindings.every(
      ({ provider, present }) =>
        entry.providers.some((link) => link.provider === provider) === present,
    )
  ) {
    return false;
  }
  const needle = filters.text.trim().toLowerCase();
  return (
    needle === "" ||
    entry.title.toLowerCase().includes(needle) ||
    entry.id.toLowerCase().includes(needle) ||
    entry.providers.some(
      (link) =>
        link.externalId.toLowerCase().includes(needle) ||
        link.sourceName?.toLowerCase().includes(needle),
    )
  );
}
