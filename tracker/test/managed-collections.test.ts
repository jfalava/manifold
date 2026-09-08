import { describe, expect, it, vi } from "vitest";

import type { AniListLibraryItem, PersonalApiClient } from "@manifold/paperback-runtime";

import { resolveManagedCollectionEntries } from "../src/MANIFOLD/managed-collections";

const items = (count: number): AniListLibraryItem[] =>
  Array.from({ length: count }, (_, index) => ({
    anilistId: String(index + 1),
    status: "reading",
    title: `Title ${index + 1}`,
  }));

describe("managed collection registry resolution", () => {
  it("resolves large shelves in bounded batches", async () => {
    const calls: (readonly { readonly providerId: string }[])[] = [];
    const resolveEntries: PersonalApiClient["resolveEntries"] = async (inputs) => {
      calls.push(inputs);
      return inputs.map((input) => ({
        id: `entry-${input.providerId}`,
        provider: "local" as const,
        providerId: input.providerId,
        title: input.title,
        createdAt: 1,
        updatedAt: 1,
        providers: [{
          provider: "anilist" as const,
          externalId: input.providerId,
          updatedAt: 1,
        }],
      }));
    };

    const resolved = await resolveManagedCollectionEntries(items(101), { resolveEntries });

    expect(calls.map((call) => call.length)).toEqual([50, 50, 1]);
    expect(resolved.get("51")?.id).toBe("entry-51");
    expect(resolved.get("101")?.id).toBe("entry-101");
  });

  it("keeps successful batches when one batch fails", async () => {
    const resolveEntries = vi.fn<PersonalApiClient["resolveEntries"]>(async (inputs) => {
      if (inputs[0]?.providerId === "51") {
        throw new Error("HTTP 502");
      }
      return inputs.map((input) => ({
        id: `entry-${input.providerId}`,
        provider: "local" as const,
        providerId: input.providerId,
        title: input.title,
        createdAt: 1,
        updatedAt: 1,
        providers: [{
          provider: "anilist" as const,
          externalId: input.providerId,
          updatedAt: 1,
        }],
      }));
    });

    const resolved = await resolveManagedCollectionEntries(items(101), { resolveEntries });

    expect(resolved.get("1")?.id).toBe("entry-1");
    expect(resolved.get("51")).toBeUndefined();
    expect(resolved.get("101")?.id).toBe("entry-101");
  });
});
