import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@manifold/json";

interface ResponseLike {
  status: number;
  headers: Record<string, string>;
}

interface ApplicationHarness {
  sleep: (seconds: number) => Promise<void>;
  arrayBufferToUTF8String: (buffer: ArrayBuffer) => string;
  scheduleRequest: () => Promise<[ResponseLike, ArrayBuffer]>;
}

interface GlobalWithApplication {
  Application?: ApplicationHarness;
}

const jsonResponse = (payload: JsonValue): ArrayBuffer =>
  // SAFETY: Node runtime value is ArrayBuffer in this IAC/CLI context
  new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer;

const makeHarness = () => {
  const sleeps: number[] = [];
  let inFlight = 0;
  let overlapped = false;
  const requests: Array<{ body: string }> = [];

  const install = (respond: (index: number) => { status: number; headers?: Record<string, string>; body?: JsonValue }) => {
    let index = 0;
    // SAFETY: vitest installs a Paperback Application stub on globalThis for this suite
    (globalThis as GlobalWithApplication).Application = {
      sleep: async (seconds: number): Promise<void> => {
        sleeps.push(seconds);
      },
      arrayBufferToUTF8String: (buffer: ArrayBuffer): string =>
        new TextDecoder().decode(buffer),
      scheduleRequest: async (): Promise<[ResponseLike, ArrayBuffer]> => {
        const callIndex = index++;
        if (inFlight > 0) {overlapped = true;}
        inFlight += 1;
        requests.push({ body: "" });
        try {
          await Promise.resolve();
          const outcome = respond(callIndex);
          return [
            { status: outcome.status, headers: outcome.headers ?? {} },
            jsonResponse(outcome.body ?? { data: {} }),
          ];
        } finally {
          inFlight -= 1;
        }
      },
    };
    return () => index;
  };

  const loadModule = async () =>
    // SAFETY: value matches typeof import("../src/anilist-graphql.js") at this call site
    (await import("../src/anilist-graphql.js")) as typeof import("../src/anilist-graphql.js");

  return { sleeps, requests, overlappedRef: () => overlapped, install, loadModule };
};

describe("aniListRequest throttling", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    vi.resetModules();
    harness = makeHarness();
  });

  afterEach(() => {
    // SAFETY: clear the Application stub installed for this suite
    delete (globalThis as GlobalWithApplication).Application;
    vi.restoreAllMocks();
  });

  it("serializes concurrent requests instead of firing them together", async () => {
    const getCallCount = harness.install(() => ({
      status: 200,
      body: { data: { Viewer: { id: 1, name: "x" } } },
    }));
    const { aniListRequest, viewerQuery } = await harness.loadModule();

    const results = await Promise.all([
      aniListRequest("t", viewerQuery),
      aniListRequest("t", viewerQuery),
      aniListRequest("t", viewerQuery),
    ]);

    expect(results).toHaveLength(3);
    expect(getCallCount()).toBe(3);
    expect(harness.overlappedRef()).toBe(false);
    // Two queued callers had to wait out the minimum spacing.
    expect(harness.sleeps.filter((seconds) => seconds >= 2)).toHaveLength(2);
  });

  it("honours retry-after on a 429, cools down, and retries successfully", async () => {
    let calls = 0;
    const getCallCount = harness.install(() => {
      calls += 1;
      if (calls === 1) {
        const body: JsonValue = { errors: [{ message: "Too Many Requests.", status: 429 }] };
        return { status: 429, headers: { "Retry-After": "38" }, body };
      }
      const body: JsonValue = { data: { Viewer: { id: 7, name: "y" } } };
      return { status: 200, body };
    });
    const { aniListRequest, viewerQuery } = await harness.loadModule();

    const result = await aniListRequest<{ Viewer: { id: number } }>("t", viewerQuery);

    expect(result.Viewer.id).toBe(7);
    expect(getCallCount()).toBe(2);
    expect(harness.sleeps.some((seconds) => seconds >= 38)).toBe(true);
  });

  it("gives up when AniList keeps answering 429", async () => {
    const getCallCount = harness.install(() => ({
      status: 429,
      headers: { "retry-after": "5" },
      body: { errors: [{ message: "Too Many Requests." }] },
    }));
    const { aniListRequest, viewerQuery } = await harness.loadModule();

    await expect(aniListRequest("t", viewerQuery)).rejects.toThrow(/rate limit/i);
    // First attempt + three backoff retries.
    expect(getCallCount()).toBe(4);
  });

  it("keeps mapping auth rejections and GraphQL errors as before", async () => {
    const { aniListRequest, viewerQuery, AniListUnauthorizedError } = await harness.loadModule();

    harness.install(() => ({ status: 401, body: { data: null } }));
    await expect(aniListRequest("t", viewerQuery)).rejects.toBeInstanceOf(AniListUnauthorizedError);

    harness.install(() => ({ status: 200, body: { errors: [{ message: "Not Found" }] } }));
    await expect(aniListRequest("t", viewerQuery)).rejects.toThrow("AniList error: Not Found");
  });
});
