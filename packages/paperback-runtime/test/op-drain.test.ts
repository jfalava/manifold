/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics schemaSync:off */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@manifold/json";

import { bridgeErrorDetail } from "../src/errors.js";

interface ResponseLike {
  readonly status: number;
  readonly headers: Record<string, string>;
}

interface ScheduledRequestLike {
  readonly url: string;
}

// Paperback's scheduleRequest rejects with host-provided values; offline
// surfaces as a message-less `{}`. The harness replays those shapes.
const jsonBuffer = (payload: JsonValue): ArrayBuffer =>
  // SAFETY: TextEncoder always yields an ArrayBuffer in the test runtime
  new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer;

interface Outcome {
  readonly status: number;
  readonly body: JsonValue;
}

const makeHarness = () => {
  const urls: string[] = [];
  let nowMs = 1_000_000;

  const install = (respond: (index: number) => Outcome): void => {
    let index = 0;
    Object.assign(globalThis, {
      Application: {
        getState: () => undefined,
        getSecureState: () => "token",
        arrayBufferToUTF8String: (buffer: ArrayBuffer): string =>
          new TextDecoder().decode(buffer),
        scheduleRequest: (
          request: ScheduledRequestLike,
        ): Promise<[ResponseLike, ArrayBuffer]> => {
          const callIndex = index++;
          urls.push(request.url);
          return Promise.resolve().then(() => {
            const outcome = respond(callIndex);
            return [
              { status: outcome.status, headers: {} },
              jsonBuffer(outcome.body),
            ];
          });
        },
      },
    });
  };

  const loadDrain = async () =>
    // SAFETY: value matches typeof import("../src/op-drain.js") at this call site
    (await import("../src/op-drain.js")) as typeof import("../src/op-drain.js");

  const loadRuntime = async () =>
    // SAFETY: value matches typeof import("../src/runtime.js") at this call site
    (await import("../src/runtime.js")) as typeof import("../src/runtime.js");

  return {
    urls,
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
