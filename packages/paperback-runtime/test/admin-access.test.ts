import { describe, expect, it } from "vitest";
import type { Cookie } from "@paperback/types";
import type { JsonObject } from "@manifold/json";
import {
  adminAccessCookiesToRequestMap,
  deserializeAdminAccessCookies,
  filterAdminAccessCookies,
  formatAdminAccessStatus,
  serializeAdminAccessCookies,
} from "../src/admin-access";

const b64url = (json: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = Array.from(json, (ch) => ch.charCodeAt(0));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) {
      out += "==";
      break;
    }
    out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) {
      out += "=";
      break;
    }
    out += alphabet[c & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Minimal unsigned JWT with exp + email for decode tests. */
const makeJwt = (payload: JsonObject): string => {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
};

const now = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00:00Z

describe("filterAdminAccessCookies", () => {
  it("keeps CF_Authorization, pins empty domain, synthesizes expires from JWT exp", () => {
    const expSec = Math.floor(now / 1000) + 3600;
    const jwt = makeJwt({ exp: expSec, email: "you@jfa.dev", sub: "x" });
    const input: Cookie[] = [
      { name: "CF_Authorization", value: jwt, domain: "", path: "/" },
      { name: "noise", value: "1", domain: "manifold.jfa.dev", path: "/" },
      { name: "cf_clearance", value: "comix", domain: "comix.to", path: "/" },
    ];
    const out = filterAdminAccessCookies(input, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("CF_Authorization");
    expect(out[0]?.domain).toBe("manifold.jfa.dev");
    expect(out[0]?.expires?.getTime()).toBe(expSec * 1000);
  });

  it("drops cookies without CF_Authorization even if AppSession present", () => {
    const out = filterAdminAccessCookies(
      [{ name: "CF_AppSession", value: "sess", domain: "manifold.jfa.dev", path: "/" }],
      now,
    );
    expect(out).toEqual([]);
  });

  it("keeps AppSession alongside Authorization", () => {
    const jwt = makeJwt({ exp: Math.floor(now / 1000) + 60, email: "a@b.c" });
    const out = filterAdminAccessCookies(
      [
        { name: "CF_Authorization", value: jwt, domain: "manifold.jfa.dev" },
        { name: "CF_AppSession", value: "sess", domain: ".jfa.dev", path: "/" },
      ],
      now,
    );
    const names = out.map((cookie) => cookie.name);
    expect(names).toContain("CF_AppSession");
    expect(names).toContain("CF_Authorization");
    expect(out.every((cookie) => cookie.domain === "manifold.jfa.dev")).toBe(true);
  });

  it("drops expired cookies", () => {
    const jwt = makeJwt({ exp: Math.floor(now / 1000) - 10 });
    const out = filterAdminAccessCookies(
      [
        {
          name: "CF_Authorization",
          value: jwt,
          domain: "manifold.jfa.dev",
          expires: new Date(now - 1000),
        },
      ],
      now,
    );
    expect(out).toEqual([]);
  });
});

describe("serialize/deserialize AdminAccessCookies", () => {
  it("round-trips and rebuilds request cookie map", () => {
    const jwt = makeJwt({ exp: Math.floor(now / 1000) + 120, email: "ops@jfa.dev" });
    const cookies: Cookie[] = [
      {
        name: "CF_Authorization",
        value: jwt,
        domain: "manifold.jfa.dev",
        path: "/",
        expires: new Date(now + 120_000),
      },
    ];
    const raw = serializeAdminAccessCookies(cookies, now);
    const restored = deserializeAdminAccessCookies(raw, now);
    expect(restored).toHaveLength(1);
    expect(adminAccessCookiesToRequestMap(restored, now)).toEqual({ CF_Authorization: jwt });
    expect(formatAdminAccessStatus(restored, now)).toContain("ops@jfa.dev");
  });

  it("returns empty on garbage", () => {
    expect(deserializeAdminAccessCookies("not-json", now)).toEqual([]);
    expect(deserializeAdminAccessCookies("{}", now)).toEqual([]);
  });
});
