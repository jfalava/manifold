import { describe, expect, it } from "vitest";
import { resolveChannel } from "../scripts/channel";

describe("resolveChannel", () => {
  it("maps manifold-stable to the stable catalog and MANIFOLD id", () => {
    const channel = resolveChannel("manifold-stable");
    expect(channel).toMatchObject({
      envValue: "manifold-stable",
      channel: "stable",
      extensionId: "MANIFOLD",
      extensionName: "MANIFOLD",
    });
  });

  it("maps manifold-beta to the beta catalog and MANIFOLD-beta id", () => {
    const channel = resolveChannel("manifold-beta");
    expect(channel).toMatchObject({
      envValue: "manifold-beta",
      channel: "beta",
      extensionId: "MANIFOLD-beta",
      extensionName: "MANIFOLD beta",
    });
  });

  it("rejects missing or unknown ENV values", () => {
    expect(() => resolveChannel("")).toThrow(/ENV must be/);
    expect(() => resolveChannel("production")).toThrow(/ENV must be/);
    expect(() => resolveChannel("manifold-prod")).toThrow(/ENV must be/);
  });
});
