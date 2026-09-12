/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { describe, expect, it } from "vitest";
import {
  cookiesFromCdp,
  cookiesFromFlags,
  isSessionFresh,
  loadStoredSession,
  parseCookieHeader,
  parseStoredSession,
  saveStoredSession,
  sessionFromCookies,
  toCdpCookie,
  type SecretStore,
  type StoredComixSession,
} from "../src/comix-session";

const memoryStore = (): SecretStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  const key = (service: string, name: string): string => `${service}/${name}`;
  return {
    map,
    get: async (service, name) => map.get(key(service, name)) ?? null,
    set: async (service, name, value) => {
      map.set(key(service, name), value);
    },
    delete: async (service, name) => map.delete(key(service, name)),
  };
};

const session = (overrides: Partial<StoredComixSession> = {}): StoredComixSession => ({
  version: 1,
  harvestedAt: 1_700_000_000_000,
  cookies: [{ name: "cf_clearance", value: "token", domain: "comix.to", path: "/" }],
  ...overrides,
});

describe("comix cookie parsing", () => {
  it("splits a Cookie header into named comix.to cookies", () => {
    expect(parseCookieHeader("cf_clearance=abc; session=xyz; __cf_bm=bm")).toEqual([
      { name: "cf_clearance", value: "abc", domain: "comix.to", path: "/", secure: true },
      { name: "session", value: "xyz", domain: "comix.to", path: "/", secure: true },
      { name: "__cf_bm", value: "bm", domain: "comix.to", path: "/", secure: true },
    ]);
  });

  it("prefers a full Cookie header over individual flags", () => {
    expect(
      cookiesFromFlags({
        cookieHeader: "cf_clearance=from-header",
        cfClearance: "ignored",
        session: "ignored",
      }),
    ).toEqual([
      { name: "cf_clearance", value: "from-header", domain: "comix.to", path: "/", secure: true },
    ]);
  });

  it("assembles cf_clearance and session flags when no header is given", () => {
    expect(cookiesFromFlags({ cfClearance: "c", session: "s" })).toEqual([
      { name: "cf_clearance", value: "c", domain: "comix.to", path: "/", secure: true },
      { name: "session", value: "s", domain: "comix.to", path: "/", secure: true },
    ]);
  });
});

describe("comix session freshness", () => {
  it("rejects jars without cf_clearance", () => {
    expect(isSessionFresh(session({ cookies: [{ name: "session", value: "s" }] }))).toBe(false);
  });

  it("keeps a clearance with no known expiry so the browser can probe it", () => {
    expect(isSessionFresh(session(), 1_800_000_000_000)).toBe(true);
  });

  it("treats CDP seconds-since-epoch expiry as stale near the deadline", () => {
    const expires = 1_800_000_000;
    const stored = session({
      cookies: [{ name: "cf_clearance", value: "token", expires }],
    });
    expect(isSessionFresh(stored, expires * 1000 - 120_000)).toBe(true);
    expect(isSessionFresh(stored, expires * 1000 - 30_000)).toBe(false);
  });

  it("drops expired or garbage secrets instead of replaying them", async () => {
    const store = memoryStore();
    await saveStoredSession(
      store,
      session({
        cookies: [{ name: "cf_clearance", value: "old", expires: 10 }],
      }),
    );
    expect(await loadStoredSession(store, Date.now())).toBeUndefined();
    expect(store.map.size).toBe(0);

    await store.set("manifold", "comix-session", "not-json");
    expect(await loadStoredSession(store)).toBeUndefined();
    expect(store.map.size).toBe(0);
  });

  it("round-trips a fresh jar through the secret store", async () => {
    const store = memoryStore();
    const saved = sessionFromCookies(
      [{ name: "cf_clearance", value: "live", expires: 2_000_000_000 }],
      "Mozilla/5.0 Chrome/126",
      1_700_000_000_000,
    );
    await saveStoredSession(store, saved);
    expect(await loadStoredSession(store, 1_700_000_000_000)).toEqual(saved);
    expect(parseStoredSession(JSON.stringify(saved))).toEqual(saved);
  });
});

describe("comix CDP cookie conversion", () => {
  it("reads cookies from Network.getCookies envelopes and raw arrays", () => {
    expect(
      cookiesFromCdp({
        cookies: [
          { name: "cf_clearance", value: "tok", domain: ".comix.to", expires: 1_800_000_000 },
        ],
      }),
    ).toEqual([
      { name: "cf_clearance", value: "tok", domain: ".comix.to", expires: 1_800_000_000 },
    ]);
    expect(cookiesFromCdp([{ name: "session", value: "s" }])).toEqual([
      { name: "session", value: "s" },
    ]);
  });

  it("converts millisecond expiry back to CDP seconds", () => {
    expect(
      toCdpCookie({
        name: "cf_clearance",
        value: "tok",
        domain: "comix.to",
        path: "/",
        expires: 1_800_000_000_000,
        secure: true,
      }),
    ).toEqual({
      name: "cf_clearance",
      value: "tok",
      domain: "comix.to",
      path: "/",
      expires: 1_800_000_000,
      secure: true,
    });
  });
});
