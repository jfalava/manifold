import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHref, requestInitText } from "@manifold/json";
import { Option, Schema } from "effect";

import { apiCall, apiConfig } from "../../src/commands/toolbox";
import {
  DEVICE_CODE_GRANT_TYPE,
  MANIFOLD_CLI_OAUTH_CLIENT_ID,
  pollManifoldDeviceSession,
  startManifoldDeviceLogin,
} from "../../src/login/manifold";
import { numberAt, parseJsonObject, stringAt } from "../support/report";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Manifold CLI device login", () => {
  const origin = "https://manifold.example/api/";

  const grant = {
    deviceCode: "mf_device_cli",
    userCode: "BCDF-GHJK",
    verificationUri: "https://manifold.example/device",
    verificationUriComplete: "https://manifold.example/device?code=BCDF-GHJK",
    expiresInSeconds: 600,
    intervalSeconds: 5,
  };

  const formOf = (init?: RequestInit) =>
    new URLSearchParams(
      init?.body instanceof URLSearchParams ? init.body.toString() : (requestInitText(init) ?? ""),
    );

  it("starts a device authorization for the CLI client", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestHref(input)).toBe("https://manifold.example/api/v1/oauth/device_authorization");
      expect(formOf(init).get("client_id")).toBe(MANIFOLD_CLI_OAUTH_CLIENT_ID);

      return Response.json({
        device_code: "mf_device_cli",
        user_code: "BCDF-GHJK",
        verification_uri: "https://manifold.example/device",
        verification_uri_complete: "https://manifold.example/device?code=BCDF-GHJK",
        expires_in: 600,
        interval: 5,
      });
    });

    vi.stubGlobal("fetch", fetcher);

    await expect(startManifoldDeviceLogin(origin)).resolves.toEqual(grant);
  });

  /** Runs the poller under fake timers, recording the fake clock at each token request. */
  const pollWith = async (answers: readonly Response[]) => {
    vi.useFakeTimers();
    const start = Date.now();
    const pollTimes: number[] = [];
    let index = 0;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(requestHref(input)).toBe("https://manifold.example/api/v1/oauth/token");
      const form = formOf(init);
      expect(form.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
      expect(form.get("device_code")).toBe("mf_device_cli");
      expect(form.get("client_id")).toBe(MANIFOLD_CLI_OAUTH_CLIENT_ID);
      pollTimes.push(Date.now() - start);

      return answers[index++] ?? Response.json({ error: "authorization_pending" }, { status: 400 });
    });

    const result = pollManifoldDeviceSession(origin, grant).then(
      (session) => ({ ok: true as const, session }),
      (error: Error) => ({ ok: false as const, error: error.message }),
    );

    for (let step = 0; step < 40 && index < answers.length; step++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    vi.useRealTimers();

    return { outcome: await result, pollTimes };
  };

  it("keeps polling on pending, widens the interval on slow_down, and returns the session", async () => {
    const { outcome, pollTimes } = await pollWith([
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({
        access_token: "mf_access_cli",
        refresh_token: "mf_refresh_cli",
        expires_in: 900,
      }),
    ]);

    expect(outcome).toMatchObject({
      ok: true,
      session: { accessToken: "mf_access_cli", refreshToken: "mf_refresh_cli" },
    });
    // 5 s, 5 s, then 10 s after slow_down for the rest.
    expect(pollTimes).toEqual([5000, 10_000, 20_000, 30_000]);
  });

  it("stops when the browser denies the sign-in", async () => {
    const { outcome, pollTimes } = await pollWith([
      Response.json({ error: "access_denied" }, { status: 400 }),
    ]);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error).toContain("denied in the browser");
    expect(pollTimes).toEqual([5000]);
  });
});

describe("Manifold API session recovery", () => {
  const origin = "https://manifold.example/api";

  const session = (generation: number, expiresAt = Date.now() + 900_000) => ({
    accessToken: `access-${generation}`,
    refreshToken: `refresh-${generation}`,
    expiresAt,
  });

  /** Decodes what the CLI wrote back to `Bun.secrets` into the `session()` shape. */
  const storedSession = (value: string): ReturnType<typeof session> => {
    const record = parseJsonObject(value);

    return {
      accessToken: stringAt(record, "accessToken"),
      refreshToken: stringAt(record, "refreshToken"),
      expiresAt: numberAt(record, "expiresAt"),
    };
  };

  const config = () => apiConfig(Option.some(origin), Option.none());

  it.each(["expiry", "401"] as const)(
    "recovers a long-lived config after another config rotates its session: %s",
    async (trigger) => {
      vi.stubEnv("MANIFOLD_TOKEN", "");
      let stored = session(0, trigger === "expiry" ? 0 : Date.now() + 900_000);
      let generation = 0;
      vi.stubGlobal("Bun", {
        secrets: {
          get: async () => JSON.stringify(stored),
          set: async ({ value }: { value: string }) => {
            stored = storedSession(value);
          },
        },
      });
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestHref(input).endsWith("/oauth/token")) {
          const grant = new URLSearchParams(
            init?.body instanceof URLSearchParams ? init.body.toString() : requestInitText(init),
          );

          if (grant.get("refresh_token") !== `refresh-${generation}`) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }

          generation++;

          return Response.json({
            access_token: `access-${generation}`,
            refresh_token: `refresh-${generation}`,
            expires_in: 900,
          });
        }

        return generation > 0 &&
          new Headers(init?.headers).get("authorization") === `Bearer access-${generation}`
          ? Response.json({ linked: "senpai-kanojo" })
          : new Response(null, { status: 401 });
      });
      const first = await config();
      const stale = await config();
      await expect(
        apiCall(
          first,
          "/v1/registry/target/providers",
          "POST",
          { provider: "manganato", externalId: "senpai-kanojo" },
          Schema.Unknown,
        ),
      ).resolves.toEqual({ linked: "senpai-kanojo" });
      await expect(
        apiCall(
          stale,
          "/v1/registry/target/providers",
          "POST",
          { provider: "manganato", externalId: "senpai-kanojo" },
          Schema.Unknown,
        ),
      ).resolves.toEqual({ linked: "senpai-kanojo" });
      expect(generation).toBe(1);

      // The adopted refresh token must also survive the next rotation.
      stale.accessExpiresAt = 0;
      await expect(
        apiCall(stale, "/v1/registry", "GET", undefined, Schema.Unknown),
      ).resolves.toEqual({ linked: "senpai-kanojo" });
      expect(generation).toBe(2);
    },
  );

  it("refreshes a changed stored session when its access token is also expired", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    let stored = session(0, 0);
    vi.stubGlobal("Bun", {
      secrets: {
        get: async () => JSON.stringify(stored),
        set: async ({ value }: { value: string }) => {
          stored = storedSession(value);
        },
      },
    });
    const stale = await config();
    stored = session(1, 0);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).endsWith("/oauth/token")) {
        if (
          !(init?.body instanceof URLSearchParams) ||
          init.body.get("refresh_token") !== "refresh-1"
        ) {
          return new Response(null, { status: 400 });
        }

        return Response.json({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 900,
        });
      }

      return new Headers(init?.headers).get("authorization") === "Bearer access-2"
        ? Response.json({ recovered: true })
        : new Response(null, { status: 401 });
    });
    await expect(apiCall(stale, "/v1/registry", "GET", undefined, Schema.Unknown)).resolves.toEqual(
      { recovered: true },
    );
    expect(stored.refreshToken).toBe("refresh-2");
  });

  it("stops after one rejected API replay with a changed stored session", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    let stored = session(0);
    vi.stubGlobal("Bun", { secrets: { get: async () => JSON.stringify(stored) } });
    const stale = await config();
    stored = session(1);
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;

      return Response.json({ error: "Unauthorized" }, { status: 401 });
    });
    await expect(apiCall(stale, "/v1/registry", "GET", undefined, Schema.Unknown)).rejects.toThrow(
      "Unauthorized",
    );
    expect(requests).toBe(2);
  });

  it("recovers a rotation between reading storage and attempting refresh", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    let stored = session(0, 0);
    vi.stubGlobal("Bun", { secrets: { get: async () => JSON.stringify(stored) } });
    let refreshes = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).endsWith("/oauth/token")) {
        refreshes++;
        stored = session(1);

        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      return new Headers(init?.headers).get("authorization") === "Bearer access-1"
        ? Response.json({ recovered: true })
        : new Response(null, { status: 401 });
    });
    await expect(
      apiCall(await config(), "/v1/registry", "GET", undefined, Schema.Unknown),
    ).resolves.toEqual({ recovered: true });
    expect(refreshes).toBe(1);
  });

  it("does not retry a rejected refresh token when storage has not changed", async () => {
    vi.stubEnv("MANIFOLD_TOKEN", "");
    vi.stubGlobal("Bun", { secrets: { get: async () => JSON.stringify(session(0, 0)) } });
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;

      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    await expect(
      apiCall(await config(), "/v1/registry", "GET", undefined, Schema.Unknown),
    ).rejects.toThrow("Manifold OAuth refresh failed: HTTP 400");
    expect(requests).toBe(1);
  });

  it.each(["flag", "environment"] as const)(
    "keeps explicit %s tokens separate from stored sessions",
    async (source) => {
      vi.stubEnv("MANIFOLD_TOKEN", source === "environment" ? "explicit-token" : "");
      vi.stubGlobal("Bun", {
        secrets: {
          get: async () => {
            throw new Error("Explicit tokens must not use the keychain");
          },
        },
      });
      let requests = 0;
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests++;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-token");

        return Response.json({ error: "Unauthorized explicit token" }, { status: 401 });
      });

      const explicit = await apiConfig(
        Option.some(origin),
        source === "flag" ? Option.some("explicit-token") : Option.none(),
      );

      await expect(
        apiCall(explicit, "/v1/registry", "GET", undefined, Schema.Unknown),
      ).rejects.toThrow("Unauthorized explicit token");
      expect(requests).toBe(1);
    },
  );
});
