import { ListStatus } from "@manifold/contract";
import { Schema } from "effect";

/** Registry list statuses (AniList vocabulary projected into the registry). */
export const REGISTRY_STATUSES = ListStatus.literals;

export type RegistryStatus = ListStatus;

const isRegistryStatus = Schema.is(ListStatus);

/**
 * Prefill --status accepts the same short names as pas5 create --tabs, then expands
 * them onto registry vocabulary. "reading" includes re_reading the same way
 * PAS5 maps REPEATING onto the Reading tab.
 */
const STATUS_ALIASES: ReadonlyMap<string, readonly RegistryStatus[]> = new Map([
  ["reading", ["reading", "re_reading"]],
  ["paused", ["on_hold"]],
  ["on_hold", ["on_hold"]],
  ["dropped", ["dropped"]],
  ["completed", ["completed"]],
  ["planning", ["plan_to_read"]],
  ["plan_to_read", ["plan_to_read"]],
  ["re_reading", ["re_reading"]],
]);

export const STATUS_FILTER_HINT =
  "auto | comma-list of reading,paused,dropped,completed,planning (PAS5-style; expands to registry statuses)";

/** Parse --status. undefined means keep every row ("auto"). */
export const parseStatusFilter = (value: string): ReadonlySet<RegistryStatus> | undefined => {
  const trimmed = value.trim().toLowerCase();

  if (trimmed === "" || trimmed === "auto") {
    return undefined;
  }

  const names = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (names.length === 0) {
    throw new Error(`--status: no valid statuses in "${value}"`);
  }

  const allowed = new Set<RegistryStatus>();

  for (const name of names) {
    const mapped = STATUS_ALIASES.get(name);

    if (!mapped) {
      throw new Error(
        `--status: unknown status "${name}" (allowed: ${[...STATUS_ALIASES.keys()].join(", ")})`,
      );
    }

    for (const status of mapped) {
      allowed.add(status);
    }
  }

  return allowed;
};

export const matchesStatusFilter = (
  status: string | undefined,
  filter: ReadonlySet<RegistryStatus> | undefined,
): boolean => {
  if (filter === undefined) {
    return true;
  }

  if (status === undefined) {
    return false;
  }

  return isRegistryStatus(status) && filter.has(status);
};
