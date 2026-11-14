import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@manifold/json";

import { bridgeErrorDetail } from "../src/errors.js";

interface ResponseLike {
  readonly status: number;
  readonly headers: Record<string, string>;
}

interface ScheduledRequestLike {
  readonly url: string;
  readonly body?: string;
}

// Paperback's scheduleRequest rejects with host-provided values; offline
// surfaces as a message-less `{}`. The harness replays those shapes.
const jsonBuffer = (payload: JsonValue): ArrayBuffer =>
  new Uint8Array(new TextEncoder().encode(JSON.stringify(payload))).buffer;

interface Outcome {
  readonly status: number;
  readonly body: JsonValue;
}

const makeHarness = () => {
  const urls: string[] = [];
  const bodies: (string | undefined)[] = [];
  let nowMs = 1_000_000;

  const install = (respond: (index: number) => Outcome, viewerId?: number): void => {
    let index = 0;
    Object.assign(globalThis, {
      Application: {
        getState: () => viewerId,
        getSecureState: () => "token",
        sleep: (): Promise<void> => Promise.resolve(),
        arrayBufferToUTF8String: (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer),
        scheduleRequest: (request: ScheduledRequestLike): Promise<[ResponseLike, ArrayBuffer]> => {
          const callIndex = index++;
          urls.push(request.url);
          bodies.push(request.body);

          return Promise.resolve().then(() => {
            const outcome = respond(callIndex);

            return [{ status: outcome.status, headers: {} }, jsonBuffer(outcome.body)];
          });
        },
      },
    });
  };

  const loadDrain = async () => import("../src/op-drain.js");

  const loadRuntime = async () => import("../src/runtime.js");

  return {
    urls,
    bodies,
    install,
    loadDrain,
    loadRuntime,
    setNow: (value: number): void => {
      nowMs = value;
    },
    now: (): number => nowMs,
  };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

describe("bridgeErrorDetail", () => {
  it("prefers Error messages and plain strings", () => {
    expect(bridgeErrorDetail(new Error("boom"))).toBe("boom");
    expect(bridgeErrorDetail("plain failure")).toBe("plain failure");
  });

  it("reads message-like members off bridge rejection objects", () => {
    expect(bridgeErrorDetail({ message: "offline" })).toBe("offline");
    expect(bridgeErrorDetail({ code: -1009, domain: "NSURLErrorDomain" })).toBe(
      "NSURLErrorDomain (-1009)",
    );
  });

  it("names the network failure when nothing else is available", () => {
    expect(bridgeErrorDetail({})).toBe("network request failed");
    expect(bridgeErrorDetail({ note: "empty envelope" })).toBe('{"note":"empty envelope"}');
  });
});

describe("maybeDrainAniListOps throttle", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    vi.resetModules();
    harness = makeHarness();
    vi.spyOn(Date, "now").mockImplementation(() => harness.now());
  });

  afterEach(() => {
    Object.assign(globalThis, { Application: undefined });
    vi.restoreAllMocks();
  });

  it("retries soon after a failed attempt instead of burning the window", async () => {
    harness.install(() => {
      // SAFETY: replays the offline bridge rejection shape (message-less object)
      throw {};
    });
    const { maybeDrainAniListOps } = await harness.loadDrain();

    maybeDrainAniListOps();
    await vi.waitFor(() => expect(harness.urls).toHaveLength(1));
    await flush();

    harness.setNow(harness.now() + 16_000);
    maybeDrainAniListOps();
    await vi.waitFor(() => expect(harness.urls).toHaveLength(2));
  });

  it("holds the full window after a successful drain", async () => {
    harness.install(() => ({ status: 200, body: { ops: [] } }));
    const { maybeDrainAniListOps } = await harness.loadDrain();

    maybeDrainAniListOps();
    await vi.waitFor(() => expect(harness.urls).toHaveLength(1));
    await flush();

    harness.setNow(harness.now() + 30_000);
    maybeDrainAniListOps();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.urls).toHaveLength(1);

    harness.setNow(harness.now() + 31_000);
    maybeDrainAniListOps();
    await vi.waitFor(() => expect(harness.urls).toHaveLength(2));
  });
});

describe("AniList operation drain", () => {
  it("acknowledges a replayed delete when the list entry is already absent", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return {
          status: 200,
          body: {
            ops: [
              {
                id: 1,
                opId: "delete-1",
                target: "anilist",
                kind: "anilist.delete",
                origin: "device",
                payload: { anilistId: "42", mediaListEntryId: 99 },
                state: "pending",
                attempts: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        };
      }

      if (index === 1) {
        return {
          status: 200,
          body: { data: { MediaListCollection: { lists: [] } } },
        };
      }

      return { status: 200, body: { updated: 1 } };
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await drainAniListOps();

    expect(harness.urls).toEqual([
      "https://manifold.jfa.dev/api/v1/ops/pending/anilist?limit=25",
      "https://graphql.anilist.co",
      "https://manifold.jfa.dev/api/v1/ops/complete",
    ]);
  });
  it("reports a delete AniList did not confirm as failed, not drained", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return {
          status: 200,
          body: {
            ops: [
              {
                id: 1,
                opId: "delete-2",
                target: "anilist",
                kind: "anilist.delete",
                origin: "device",
                payload: { anilistId: "42", mediaListEntryId: 99 },
                state: "pending",
                attempts: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        };
      }

      if (index === 1) {
        return {
          status: 200,
          body: {
            data: { MediaListCollection: { lists: [{ entries: [{ id: 99, mediaId: 42 }] }] } },
          },
        };
      }

      if (index === 2) {
        return { status: 200, body: { data: { DeleteMediaListEntry: { deleted: false } } } };
      }

      return { status: 200, body: { updated: 1 } };
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await drainAniListOps();

    expect(harness.urls.at(-1)).toBe("https://manifold.jfa.dev/api/v1/ops/complete");
    expect(JSON.parse(harness.bodies.at(-1) ?? "{}")).toMatchObject({
      results: [{ opId: "delete-2", ok: false }],
    });
  });
});

describe("AniList operation drain failure handling", () => {
  const statusOp = (opId: string, anilistId: string): JsonValue => ({
    id: 1,
    opId,
    target: "anilist",
    kind: "anilist.status",
    origin: "admin",
    payload: { anilistId, status: "reading" },
    state: "pending",
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  const pending: Outcome = {
    status: 200,
    body: { ops: [statusOp("op-1", "41"), statusOp("op-2", "42"), statusOp("op-3", "43")] },
  };

  const saved = (id: number): Outcome => ({
    status: 200,
    body: { data: { SaveMediaListEntry: { id } } },
  });

  const anilistUrl = "https://graphql.anilist.co";
  const completeUrl = "https://manifold.jfa.dev/api/v1/ops/complete";

  it.each<[string, Outcome]>([
    ["HTTP 401", { status: 401, body: { errors: [{ message: "Unauthorized." }] } }],
    ["HTTP 403", { status: 403, body: { errors: [{ message: "Forbidden." }] } }],
    [
      "an invalid token",
      { status: 400, body: { data: null, errors: [{ message: "Invalid token", status: 400 }] } },
    ],
  ])("stops the pass on %s and acknowledges only the ops already done", async (_label, failure) => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return pending;
      }

      if (index === 1) {
        return saved(11);
      }

      return index === 2 ? failure : { status: 200, body: { updated: 1 } };
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await expect(drainAniListOps()).rejects.toThrow();

    // No request for op-3, and nothing reported for op-2 or op-3.
    expect(harness.urls.slice(1)).toEqual([anilistUrl, anilistUrl, completeUrl]);
    expect(JSON.parse(harness.bodies.at(-1) ?? "{}")).toEqual({
      results: [{ opId: "op-1", ok: true, mediaListEntryId: 11 }],
    });
  });

  const unavailable: Outcome = {
    status: 503,
    body: { errors: [{ message: "Service Unavailable" }] },
  };

  const viewer: Outcome = { status: 200, body: { data: { Viewer: { id: 1, name: "reader" } } } };

  it("counts an HTTP 503 against its op when AniList still answers a viewer query", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return pending;
      }

      if (index === 1) {
        return unavailable;
      }

      if (index === 2) {
        return viewer;
      }

      return index <= 4 ? saved(10 + index) : { status: 200, body: { updated: 3 } };
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await drainAniListOps();

    // Unreported, op-1 would be retried first on every pass and never block.
    expect(harness.bodies[2]).toContain("Viewer");
    expect(harness.urls.slice(1)).toEqual([
      anilistUrl,
      anilistUrl,
      anilistUrl,
      anilistUrl,
      completeUrl,
    ]);
    expect(JSON.parse(harness.bodies.at(-1) ?? "{}")).toEqual({
      results: [
        { opId: "op-1", ok: false, error: "AniList request failed with HTTP 503" },
        { opId: "op-2", ok: true, mediaListEntryId: 13 },
        { opId: "op-3", ok: true, mediaListEntryId: 14 },
      ],
    });
  });

  it("stops the pass on an HTTP 503 when the viewer query fails too, reporting nothing", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => (index === 0 ? pending : unavailable), 7);
    const { drainAniListOps } = await harness.loadDrain();

    await expect(drainAniListOps()).rejects.toThrow("HTTP 503");

    // One op and the viewer query: an outage is not a failed attempt.
    expect(harness.urls.slice(1)).toEqual([anilistUrl, anilistUrl]);
  });

  it("holds back a later op for the title whose op got the HTTP 503", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return {
          status: 200,
          body: {
            ops: [statusOp("older", "41"), statusOp("newer", "41"), statusOp("other", "43")],
          },
        };
      }

      if (index === 1) {
        return unavailable;
      }

      if (index === 2) {
        return viewer;
      }

      return index === 3 ? saved(13) : { status: 200, body: { updated: 2 } };
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await drainAniListOps();

    // "newer" is neither sent nor reported: applied now, the retry of "older"
    // would overwrite it on the next pass.
    expect(harness.urls.slice(1)).toEqual([anilistUrl, anilistUrl, anilistUrl, completeUrl]);
    expect(harness.bodies[3]).toContain("43");
    expect(JSON.parse(harness.bodies.at(-1) ?? "{}")).toEqual({
      results: [
        { opId: "older", ok: false, error: "AniList request failed with HTTP 503" },
        { opId: "other", ok: true, mediaListEntryId: 13 },
      ],
    });
  });

  it("stops the pass on a transport failure without reporting a completion", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return pending;
      }

      // SAFETY: replays the offline bridge rejection shape (message-less object)
      throw {};
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await expect(drainAniListOps()).rejects.toThrow("AniList request failed");
    expect(harness.urls.slice(1)).toEqual([anilistUrl]);
  });

  it("stops the pass when rate limiting outlasts the retries", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return pending;
      }

      if (index === 1) {
        return saved(11);
      }

      return index <= 5
        ? { status: 429, body: { errors: [{ message: "Too Many Requests." }] } }
        : { status: 200, body: { updated: 1 } };
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await expect(drainAniListOps()).rejects.toThrow(/rate limit/i);
    expect(harness.urls.at(-1)).toBe(completeUrl);
    expect(JSON.parse(harness.bodies.at(-1) ?? "{}")).toEqual({
      results: [{ opId: "op-1", ok: true, mediaListEntryId: 11 }],
    });
  });

  it("still reports a failure that is about the op and continues the pass", async () => {
    const harness = makeHarness();
    harness.install((index): Outcome => {
      if (index === 0) {
        return pending;
      }

      if (index === 2) {
        return {
          status: 404,
          body: { data: null, errors: [{ message: "Not Found.", status: 404 }] },
        };
      }

      return index === 4 ? { status: 200, body: { updated: 3 } } : saved(10 + index);
    }, 7);
    const { drainAniListOps } = await harness.loadDrain();

    await drainAniListOps();

    expect(JSON.parse(harness.bodies.at(-1) ?? "{}")).toEqual({
      results: [
        { opId: "op-1", ok: true, mediaListEntryId: 11 },
        { opId: "op-2", ok: false, error: "AniList error: Not Found." },
        { opId: "op-3", ok: true, mediaListEntryId: 13 },
      ],
    });
  });
});

describe("scheduledPersonalRequester", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    vi.resetModules();
    harness = makeHarness();
  });

  afterEach(() => {
    Object.assign(globalThis, { Application: undefined });
    vi.restoreAllMocks();
  });

  it("labels message-less bridge rejections with the request", async () => {
    harness.install(() => {
      // SAFETY: replays the offline bridge rejection shape (message-less object)
      throw {};
    });
    const { scheduledPersonalRequester } = await harness.loadRuntime();

    await expect(
      scheduledPersonalRequester({
        url: "https://personal.test/v1/ops/pending/anilist?limit=25",
        method: "GET",
        headers: { accept: "application/json" },
      }),
    ).rejects.toThrow(
      "Personal API request failed: GET https://personal.test/v1/ops/pending/anilist?limit=25 (network request failed)",
    );
  });
});
