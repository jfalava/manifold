import { describe, expect, it } from "vitest";
import {
  EntryByProviderResponse,
  ListStateResponse,
  ProgressResponse,
  RegistryEntry,
  encodeResponse,
  decodeResponse,
} from "../src/index.ts";

const sampleEntry = {
  id: "11111111-1111-1111-1111-111111111111",
  provider: "anilist" as const,
  providerId: "42",
  title: "Demo",
  createdAt: 1,
  updatedAt: 2,
  providers: [
    {
      provider: "anilist" as const,
      externalId: "42",
      updatedAt: 2,
    },
  ],
};

describe("encodeResponse", () => {
  it("encodes a registry entry", () => {
    const wire = encodeResponse(RegistryEntry, sampleEntry);
    expect(wire).toEqual(sampleEntry);
  });

  it("encodes always-wrapped null progress", () => {
    expect(encodeResponse(ProgressResponse, { progress: null })).toEqual({ progress: null });
  });

  it("encodes always-wrapped null list state", () => {
    expect(encodeResponse(ListStateResponse, { state: null })).toEqual({ state: null });
  });

  it("encodes always-wrapped null entry-by-provider", () => {
    expect(encodeResponse(EntryByProviderResponse, { entry: null })).toEqual({ entry: null });
  });
});

describe("decodeResponse", () => {
  it("decodes a valid body", () => {
    expect(decodeResponse(RegistryEntry, sampleEntry, "entry")).toEqual(sampleEntry);
  });

  it("returns undefined and does not throw on garbage", () => {
    expect(decodeResponse(RegistryEntry, { nope: true }, "entry")).toBeUndefined();
  });
});
