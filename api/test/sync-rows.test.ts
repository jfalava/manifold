import { describe, expect, it } from "vitest";
import { encodeResponse, RegistryEntry } from "@manifold/contract";
import { toRegistryEntry, type EntryRow, type ProviderRow } from "../src/sync-rows.js";

const baseRow = (overrides: Partial<EntryRow> = {}): EntryRow => ({
  id: "ae13e11b-9e53-45db-8d72-18b7c07bb377",
  provider: "anilist",
  provider_id: "123",
  title: "Demo Title",
  created_at: 1,
  updated_at: 2,
  tombstoned_at: null,
  ...overrides,
});

describe("toRegistryEntry", () => {
  it("encodes a healthy entry", () => {
    const entry = toRegistryEntry(baseRow(), [
      {
        provider: "anilist",
        external_id: "123",
        title: null,
        updated_at: 2,
      },
      {
        provider: "mangadex",
        external_id: "md-1",
        title: "MD",
        updated_at: 3,
      },
    ]);
    expect(() => encodeResponse(RegistryEntry, entry)).not.toThrow();
    expect(entry.providers).toHaveLength(2);
  });

  it("drops empty external ids and unknown providers", () => {
    const entry = toRegistryEntry(baseRow(), [
      {
        provider: "mangadex",
        external_id: "",
        title: "x",
        updated_at: 1,
      },
      {
        provider: "mangadex",
        external_id: "   ",
        title: "y",
        updated_at: 1,
      },
      {
        // SAFETY: intentional corrupt historical provider for sanitize coverage
        provider: "unknown" as ProviderRow["provider"],
        external_id: "z",
        title: null,
        updated_at: 1,
      },
      {
        provider: "comix",
        external_id: "hid1",
        title: "",
        updated_at: 1,
      },
    ]);
    expect(entry.providers).toEqual([
      { provider: "comix", externalId: "hid1", updatedAt: 1 },
    ]);
    expect(() => encodeResponse(RegistryEntry, entry)).not.toThrow();
  });

  it("coerces empty required strings so encode never fails", () => {
    const entry = toRegistryEntry(
      baseRow({
        // SAFETY: Intentional corrupt provider value in test fixture to verify fallback to "local".
        provider: "not-a-provider" as EntryRow["provider"],
        provider_id: "  ",
        title: "",
      }),
      [],
    );
    expect(entry.provider).toBe("local");
    expect(entry.providerId).toBe(entry.id);
    expect(entry.title).toBe(entry.id);
    expect(() => encodeResponse(RegistryEntry, entry)).not.toThrow();
  });
});
