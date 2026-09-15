/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@manifold/json";

import {
  MANIFOLD_API_ACCESS_EXPIRES_AT_KEY,
  MANIFOLD_API_ACCESS_TOKEN_KEY,
  MANIFOLD_API_REFRESH_TOKEN_KEY,
  MANIFOLD_OAUTH_TOKEN_ENDPOINT,
} from "../src/api";

type ScheduledRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
};

type ResponseBody = {
  readonly status: number;
  readonly body: JsonValue;
};

const entry = {
  id: "entry-1",
  provider: "anilist",
  providerId: "1",
  title: "Example",
  createdAt: 1,
  updatedAt: 2,
  providers: [],
};

const installApplication = (
  secureState: Map<string, string>,
  respond: (request: ScheduledRequest, index: number) => ResponseBody,
) => {
  const requests: ScheduledRequest[] = [];
  let index = 0;
  Object.assign(globalThis, {
    Application: {
      getSecureState: (key: string) => secureState.get(key),
      setSecureState: (value: string, key: string) => secureState.set(key, value),
      setState: vi.fn(),
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: ScheduledRequest) => {
        requests.push(request);
        const outcome = respond(request, index++);
        // SAFETY: TextEncoder always returns a Uint8Array backed by an ArrayBuffer here.
        const body = new TextEncoder().encode(JSON.stringify(outcome.body)).buffer as ArrayBuffer;
        return [{ status: outcome.status, headers: {} }, body];
      },
    },
  });
  return requests;
};

describe("Manifold OAuth session runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    Object.assign(globalThis, { Application: undefined });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes an expiring session before the API request", async () => {
    const secureState = new Map([
      [MANIFOLD_API_ACCESS_TOKEN_KEY, "old-access"],
      [MANIFOLD_API_REFRESH_TOKEN_KEY, "old-refresh"],
      [MANIFOLD_API_ACCESS_EXPIRES_AT_KEY, "1000001"],
    ]);
    const requests = installApplication(secureState, (request): ResponseBody => {
      if (request.url === MANIFOLD_OAUTH_TOKEN_ENDPOINT) {
        const form = new URLSearchParams(request.body);
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("old-refresh");
        return {
          status: 200,
          body: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 900,
          },
        };
      }
      return { status: 200, body: entry };
    });

    const { configuredPersonalApi } = await import("../src/runtime");
    await expect(configuredPersonalApi().getEntry(entry.id)).resolves.toEqual(entry);

    expect(requests.map(({ url }) => url)).toEqual([
      MANIFOLD_OAUTH_TOKEN_ENDPOINT,
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
    ]);
    expect(requests[1]?.headers.authorization).toBe("Bearer new-access");
    expect(secureState.get(MANIFOLD_API_ACCESS_TOKEN_KEY)).toBe("new-access");
    expect(secureState.get(MANIFOLD_API_REFRESH_TOKEN_KEY)).toBe("new-refresh");
  });

  it("refreshes once after a 401 and retries with the rotated access token", async () => {
    const secureState = new Map([
      [MANIFOLD_API_ACCESS_TOKEN_KEY, "old-access"],
      [MANIFOLD_API_REFRESH_TOKEN_KEY, "old-refresh"],
      [MANIFOLD_API_ACCESS_EXPIRES_AT_KEY, "2000000"],
    ]);
    const requests = installApplication(secureState, (request): ResponseBody => {
      if (request.url === MANIFOLD_OAUTH_TOKEN_ENDPOINT) {
        return {
          status: 200,
          body: {
            access_token: "retried-access",
            refresh_token: "retried-refresh",
            expires_in: 900,
          },
        };
      }
      if (requests.length === 1) {
        return { status: 401, body: { error: "expired" } };
      }
      return { status: 200, body: entry };
    });

    const { configuredPersonalApi } = await import("../src/runtime");
    await expect(configuredPersonalApi().getEntry(entry.id)).resolves.toEqual(entry);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
      MANIFOLD_OAUTH_TOKEN_ENDPOINT,
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
    ]);
    expect(requests[0]?.headers.authorization).toBe("Bearer old-access");
    expect(requests[2]?.headers.authorization).toBe("Bearer retried-access");
  });
});
