/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import {
  EntryByProviderResponse,
  ListStateResponse,
  ProgressResponse,
  RegistryEntry,
  ResponseDecodeError,
  decodeResponse,
  decodeResponseEffect,
  encodeResponse,
  encodeResponseEffect,
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

  it("encodeResponseEffect succeeds for a registry entry", () => {
    const wire = Effect.runSync(encodeResponseEffect(RegistryEntry, sampleEntry));
    expect(wire).toEqual(sampleEntry);
  });
});

describe("decodeResponse", () => {
  it("decodes a valid body", () => {
    expect(decodeResponse(RegistryEntry, sampleEntry, "entry")).toEqual(sampleEntry);
  });

  it("throws a labeled error on garbage", () => {
    expect(() => decodeResponse(RegistryEntry, { nope: true }, "entry")).toThrow(
      ResponseDecodeError,
    );
    expect(() => decodeResponse(RegistryEntry, { nope: true }, "entry")).toThrow(
      "Response decode failed (entry)",
    );
  });

  it("decodeResponseEffect fails with ResponseDecodeError on garbage", () => {
    const result = Effect.runSync(
      Effect.result(decodeResponseEffect(RegistryEntry, { nope: true }, "entry")),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ResponseDecodeError);
      expect(result.failure.label).toBe("entry");
    }
  });
});
