/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@manifold/json";

// These persisted keys and endpoint are external contracts; keep expectations
// independent from the constants imported by the runtime under test.
const API_ACCESS_EXPIRES_AT_KEY = "manifold.api-access-expires-at";
const API_ACCESS_TOKEN_KEY = "manifold.api-access-token";
const API_REFRESH_TOKEN_KEY = "manifold.api-refresh-token";
const API_STATUS_KEY = "manifold.api-token-status";
const API_TOKEN_KEY = "manifold.api-token";
const OAUTH_TOKEN_URL = "https://manifold.jfa.dev/api/v1/oauth/token";

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
  const setState = vi.fn();
  const setSecureState = vi.fn((value: string, key: string) => secureState.set(key, value));
  let index = 0;
  Object.assign(globalThis, {
    Application: {
      getSecureState: (key: string) => secureState.get(key),
      setSecureState,
      setState,
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
  return { requests, setState, setSecureState };
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
      [API_ACCESS_TOKEN_KEY, "old-access"],
      [API_REFRESH_TOKEN_KEY, "old-refresh"],
      [API_ACCESS_EXPIRES_AT_KEY, "1000001"],
    ]);
    const { requests } = installApplication(secureState, (request): ResponseBody => {
      if (request.url === OAUTH_TOKEN_URL) {
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
    await configuredPersonalApi().getEntry(entry.id);

    expect(requests.map(({ url }) => url)).toEqual([
      OAUTH_TOKEN_URL,
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
    ]);
    expect(requests[1]?.headers.authorization).toBe("Bearer new-access");
    expect(secureState.get(API_ACCESS_TOKEN_KEY)).toBe("new-access");
    expect(secureState.get(API_REFRESH_TOKEN_KEY)).toBe("new-refresh");
  });

  it("refreshes once after a 401 and retries with the rotated access token", async () => {
    const secureState = new Map([
      [API_ACCESS_TOKEN_KEY, "old-access"],
      [API_REFRESH_TOKEN_KEY, "old-refresh"],
      [API_ACCESS_EXPIRES_AT_KEY, "2000000"],
    ]);
    const { requests } = installApplication(secureState, (request): ResponseBody => {
      if (request.url === OAUTH_TOKEN_URL) {
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
    await configuredPersonalApi().getEntry(entry.id);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
      OAUTH_TOKEN_URL,
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
    ]);
    expect(requests[0]?.headers.authorization).toBe("Bearer old-access");
    expect(requests[2]?.headers.authorization).toBe("Bearer retried-access");
  });

  it("marks a rejected manual token as unauthorized", async () => {
    const secureState = new Map([[API_TOKEN_KEY, "manual-token"]]);
    const { requests, setState } = installApplication(secureState, () => ({
      status: 401,
      body: { error: "Unauthorized" },
    }));

    const { configuredPersonalApi } = await import("../src/runtime");
    await expect(configuredPersonalApi().getEntry(entry.id)).rejects.toThrow("Unauthorized");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe("Bearer manual-token");
    expect(setState).toHaveBeenCalledWith(
      "Unauthorized — replace the token or log in with GitHub",
      API_STATUS_KEY,
    );
  });

  it("clears a rejected OAuth session after one refresh retry", async () => {
    const secureState = new Map([
      [API_ACCESS_TOKEN_KEY, "old-access"],
      [API_REFRESH_TOKEN_KEY, "old-refresh"],
      [API_ACCESS_EXPIRES_AT_KEY, "2000000"],
    ]);
    const { requests, setState, setSecureState } = installApplication(
      secureState,
      (request): ResponseBody =>
        request.url === OAUTH_TOKEN_URL
          ? {
              status: 200,
              body: {
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 900,
              },
            }
          : { status: 401, body: { error: "Unauthorized" } },
    );

    const { configuredPersonalApi } = await import("../src/runtime");
    await expect(configuredPersonalApi().getEntry(entry.id)).rejects.toThrow("Unauthorized");

    expect(requests.map(({ url }) => url)).toEqual([
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
      OAUTH_TOKEN_URL,
      "https://manifold.jfa.dev/api/v1/entries/entry-1",
    ]);
    expect(setSecureState).toHaveBeenCalledWith("", API_ACCESS_TOKEN_KEY);
    expect(setSecureState).toHaveBeenCalledWith("", API_REFRESH_TOKEN_KEY);
    expect(setState).toHaveBeenLastCalledWith(
      "Unauthorized — replace the token or log in with GitHub",
      API_STATUS_KEY,
    );
  });
});
