/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { Env } from "../src/types";
import { handleAuth } from "../src/routes/health-auth";

const devicePage = async (): Promise<string> => {
  const effect = handleAuth({
    request: new Request("https://api.manifold.test/v1/auth/anilist/device"),
    // SAFETY: the device branch never touches env; it only renders the page.
    env: {} as Env,
    url: new URL("https://api.manifold.test/v1/auth/anilist/device"),
    path: ["v1", "auth", "anilist", "device"],
  });
  const response = await Effect.runPromise(effect);
  if (!response) {
    throw new Error("device route returned no response");
  }
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

describe("GET /v1/auth/anilist/device", () => {
  it("authorizes the Worker AniList app (49060) with the implicit flow", async () => {
    const html = await devicePage();
    expect(html).toContain("client_id=49060");
    expect(html).toContain("response_type=token");
  });

  it("never offers the CLI app (49218), which redirects to localhost", async () => {
    expect(await devicePage()).not.toContain("49218");
  });
});
