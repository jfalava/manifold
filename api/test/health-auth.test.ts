/** @effect-diagnostics asyncFunction:off */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { testEnv } from "./env-fixture";
import { handleAuth, handleHealth } from "../src/routes/health-auth";

const deviceUrl = "https://api.manifold.test/v1/auth/anilist/device";

const authResponse = async (
  path: readonly string[],
  method = "GET",
  href = deviceUrl,
): Promise<Response> => {
  const response = await Effect.runPromise(
    handleAuth({
      request: new Request(href, { method }),
      env: testEnv(),
      url: new URL(href),
      path,
    }),
  );

  if (!response) {
    throw new Error("auth route returned no response");
  }

  return response;
};

const devicePath = ["v1", "auth", "anilist", "device"];

const devicePage = async (): Promise<string> => {
  const response = await authResponse(devicePath);
  expect(response.headers.get("content-type")).toContain("text/html");

  return response.text();
};

describe("GET /health", () => {
  it("reports only liveness and the environment, with no hand-maintained build label", async () => {
    const url = new URL("https://api.manifold.test/health");

    const response = await Effect.runPromise(
      handleHealth({ request: new Request(url), env: testEnv(), url, path: ["health"] }),
    );

    expect(await response?.json()).toEqual({ ok: true, environment: "test" });
  });
});

describe("GET /v1/auth/anilist/device", () => {
  it("authorizes the Worker AniList app (49060) with the implicit flow", async () => {
    const html = await devicePage();
    expect(html).toContain("client_id=49060");
    expect(html).toContain("response_type=token");
  });

  it("never offers the CLI app (49218), which redirects to localhost", async () => {
    expect(await devicePage()).not.toContain("49218");
  });

  it("serves the token page uncached under a policy that only runs its own nonced code", async () => {
    const response = await authResponse(devicePath);
    const html = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([\w-]+)'/.exec(policy)?.[1];

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(nonce).toBeTruthy();
    expect(policy).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    // A nonce covers elements only: inline handlers and style attributes would be blocked.
    expect(html).not.toMatch(/\son\w+=/);
    expect(html).not.toContain("style=");

    const second = await authResponse(devicePath);
    expect(second.headers.get("content-security-policy")).not.toBe(policy);
  });

  it("serves the page only for GET on the exact path", async () => {
    const posted = await authResponse(devicePath, "POST");
    expect(posted.status).toBe(404);
    expect(posted.headers.get("content-type")).not.toContain("text/html");

    const nested = await authResponse([...devicePath, "extra"], "GET", `${deviceUrl}/extra`);

    expect(nested.status).toBe(404);
    expect(nested.headers.get("content-type")).not.toContain("text/html");
  });
});
