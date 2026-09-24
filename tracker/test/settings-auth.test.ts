/** @effect-diagnostics asyncFunction:off */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Form } from "@paperback/types";

// Persisted setting names and the endpoint are hard-coded contracts, not imports
// from the implementation under test.
const API_ACCESS_EXPIRES_AT_KEY = "manifold.api-access-expires-at";
const API_ACCESS_TOKEN_KEY = "manifold.api-access-token";
const API_REFRESH_TOKEN_KEY = "manifold.api-refresh-token";
const API_STATUS_KEY = "manifold.api-token-status";
const API_TOKEN_KEY = "manifold.api-token";
const REGISTRY_CHECK_URL = "https://manifold.jfa.dev/api/v1/registry?limit=1&offset=0";

type ScheduledRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
};

type SettingsCallbacks = Form & {
  manifoldOAuthSuccess(firstToken: string, secondToken: string): Promise<void>;
  manifoldTokenChanged(value: string): Promise<void>;
};

const installApplication = (responseStatus = 200) => {
  vi.spyOn(Form.prototype, "reloadForm").mockImplementation(() => undefined);
  const secureState = new Map<string, string>();
  const state = new Map<string, string | number>();
  const requests: ScheduledRequest[] = [];
  vi.stubGlobal("Application", {
    getSecureState: (key: string) => secureState.get(key),
    setSecureState: (value: string, key: string) => {
      if (value) {
        secureState.set(key, value);
      } else {
        secureState.delete(key);
      }
    },
    getState: (key: string) => state.get(key),
    setState: (value: string | number, key: string) => state.set(key, value),
    Selector: (_target: never, key: string) => key,
    arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    scheduleRequest: async (request: ScheduledRequest) => {
      requests.push(request);
      // SAFETY: TextEncoder returns an ArrayBuffer-backed Uint8Array here.
      const body = new TextEncoder().encode('{"entries":[]}').buffer as ArrayBuffer;
      return [{ status: responseStatus, headers: {} }, body];
    },
  });
  return { secureState, state, requests };
};

const settingsForm = async (): Promise<SettingsCallbacks> => {
  const { ManifoldTrackerSource } = await import("../src/MANIFOLD/main");
  const form = await new ManifoldTrackerSource().getSettingsForm();
  // SAFETY: this settings form declares both callbacks in its selector configuration.
  return form as SettingsCallbacks;
};

describe("Manifold API settings authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("accepts a secure manual API token and verifies it with a read-only request", async () => {
    const { secureState, state, requests } = installApplication();
    secureState.set(API_ACCESS_TOKEN_KEY, "old-access");
    secureState.set(API_REFRESH_TOKEN_KEY, "old-refresh");
    secureState.set(API_ACCESS_EXPIRES_AT_KEY, "12345");
    const form = await settingsForm();
    const apiSection = form.getSections().find((section) => section.id === "tracker-personal-api");
    const tokenInput = apiSection?.items.find((item) => item.id === "tracker-personal-api-token");

    expect(tokenInput).toMatchObject({
      title: "Manual API token",
      value: "",
      isSecureEntry: true,
    });

    await form.manifoldTokenChanged("  manual-token  ");
    await form.formDidSubmit?.();

    expect(requests).toEqual([
      {
        url: REGISTRY_CHECK_URL,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer manual-token",
        },
      },
    ]);
    expect(secureState.get(API_TOKEN_KEY)).toBe("manual-token");
    expect(secureState.has(API_ACCESS_TOKEN_KEY)).toBe(false);
    expect(secureState.has(API_REFRESH_TOKEN_KEY)).toBe(false);
    expect(secureState.has(API_ACCESS_EXPIRES_AT_KEY)).toBe(false);
    expect(state.get(API_STATUS_KEY)).toBe("Manual token connected");
  });

  it("does not show a legacy Configured status as authenticated and reports a rejected token", async () => {
    const { secureState, state } = installApplication(401);
    secureState.set(API_TOKEN_KEY, "stale-token");
    const form = await settingsForm();
    state.set(API_STATUS_KEY, "Configured");
    const statusBeforeSave = form
      .getSections()
      .find((section) => section.id === "tracker-personal-api")
      ?.items.find((item) => item.id === "tracker-personal-api-status");

    expect(statusBeforeSave).toMatchObject({
      value: "Manual token saved — not verified",
      style: "warning",
    });

    await form.manifoldTokenChanged("expired-token");
    await form.formDidSubmit?.();

    expect(secureState.get(API_TOKEN_KEY)).toBe("expired-token");
    expect(state.get(API_STATUS_KEY)).toBe("Token rejected: check it or log in again");
    const statusAfterSave = form
      .getSections()
      .find((section) => section.id === "tracker-personal-api")
      ?.items.find((item) => item.id === "tracker-personal-api-status");
    expect(statusAfterSave).toMatchObject({ style: "error" });
  });

  it("clears the manual token when GitHub login succeeds", async () => {
    const { secureState, state } = installApplication();
    secureState.set(API_TOKEN_KEY, "old-manual-token");
    const form = await settingsForm();

    await form.manifoldOAuthSuccess("mf_refresh_new", "mf_access_new");

    expect(secureState.has(API_TOKEN_KEY)).toBe(false);
    expect(secureState.get(API_ACCESS_TOKEN_KEY)).toBe("mf_access_new");
    expect(secureState.get(API_REFRESH_TOKEN_KEY)).toBe("mf_refresh_new");
    expect(state.get(API_STATUS_KEY)).toBe("Connected");
  });
});
