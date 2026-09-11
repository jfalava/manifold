import { describe, expect, it } from "vitest";
import type { JsonValue } from "@manifold/json";
import { isRegistryBackupKey, parseRegistryBackup, toBackupRows } from "../src/registry-backup";

const emptyBackup = {
  version: 1,
  kind: "manifold-sync",
  createdAt: 1_700_000_000_000,
  bookmark: "bookmark-1",
  databaseSize: 4096,
  tokenKeyHash: "a".repeat(64),
  tables: {
    canonical_entries: [],
    provider_links: [],
    read_events: [],
    progress_state: [],
    md_status_queue: [],
    md_feed_stats: [],
    oauth_tokens: [],
    list_state: [],
    sync_ops: [],
    list_events: [],
  },
} satisfies JsonValue;

describe("registry backups", () => {
  it("validates a complete backup envelope", () => {
    expect(parseRegistryBackup(emptyBackup)).toEqual(emptyBackup);
  });

  it("rejects incomplete rows", () => {
    const invalid = {
      ...emptyBackup,
      tables: {
        ...emptyBackup.tables,
        canonical_entries: [{ id: "missing-the-other-columns" }],
      },
    } satisfies JsonValue;

    expect(() => parseRegistryBackup(invalid)).toThrow(/canonical_entries.*provider/u);
  });

  it("restores shelf rows predating the last_error DLQ column", () => {
    const legacy = {
      ...emptyBackup,
      tables: {
        ...emptyBackup.tables,
        md_status_queue: [{ entry_id: "entry-1", created_at: 1, attempts: 5 }],
      },
    } satisfies JsonValue;

    expect(parseRegistryBackup(legacy).tables.md_status_queue).toEqual([
      { entry_id: "entry-1", created_at: 1, attempts: 5, last_error: null },
    ]);
  });

  it("round-trips shelf rows with last_error", () => {
    const current = {
      ...emptyBackup,
      tables: {
        ...emptyBackup.tables,
        md_status_queue: [{ entry_id: "entry-1", created_at: 1, attempts: 5, last_error: "boom" }],
      },
    } satisfies JsonValue;

    expect(parseRegistryBackup(current).tables.md_status_queue).toEqual(
      current.tables.md_status_queue,
    );
  });

  it("accepts only generated registry backup keys", () => {
    expect(
      isRegistryBackupKey("registry/1700000000000-01234567-89ab-cdef-0123-456789abcdef.json"),
    ).toBe(true);
    expect(isRegistryBackupKey("registry/../registry.json")).toBe(false);
    expect(isRegistryBackupKey("other/1700000000000-backup.json")).toBe(false);
  });

  it("rejects binary SQL values before JSON serialization", () => {
    expect(() => toBackupRows([{ value: new ArrayBuffer(1) }], ["value"])).toThrow(
      /non-JSON SQL value/u,
    );
  });
});
