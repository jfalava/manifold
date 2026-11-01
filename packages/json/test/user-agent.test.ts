import { describe, expect, it } from "vitest";

import {
  MANIFOLD_USER_AGENT_HOME,
  MANIFOLD_USER_AGENT_PRODUCT,
  manifoldUserAgent,
  withManifoldUserAgent,
} from "../src/user-agent";

describe("manifoldUserAgent", () => {
  it("appends the calling surface after the home URL", () => {
    expect(manifoldUserAgent("cli")).toBe(
      `${MANIFOLD_USER_AGENT_PRODUCT} (+${MANIFOLD_USER_AGENT_HOME}; manifold/cli)`,
    );
    expect(manifoldUserAgent("api")).toContain("manifold/api");
    expect(manifoldUserAgent("admin")).toContain("manifold/admin");
  });

  it("falls back to unknown for blank surfaces", () => {
    expect(manifoldUserAgent("   ")).toContain("manifold/unknown");
  });
});

describe("withManifoldUserAgent", () => {
  it("injects user-agent when missing", () => {
    expect(withManifoldUserAgent("router", { accept: "application/json" })).toEqual({
      accept: "application/json",
      "user-agent": manifoldUserAgent("router"),
    });
  });

  it("does not clobber an explicit user-agent", () => {
    expect(withManifoldUserAgent("cli", { "user-agent": "custom/1" })).toEqual({
      "user-agent": "custom/1",
    });
  });
});
