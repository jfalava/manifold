import { expect, test } from "bun:test";
import type { Fetcher } from "@cloudflare/workers-types";
import router, { type Env } from "../src/index";

interface RecordedRequest {
  pathname: string;
  search: string;
  method: string;
}

type BindingName = keyof Env;

interface TestEnv {
  readonly calls: {
    readonly SYNC_API: RecordedRequest[];
    readonly DOCS_WORKER: RecordedRequest[];
    readonly ADMIN: RecordedRequest[];
  };
  readonly env: Env;
}

function makeEnv(): TestEnv {
  const calls = {
    // SAFETY: HTTP value is the expected RecordedRequest[] after the preceding check
    SYNC_API: [] as RecordedRequest[],
    // SAFETY: HTTP value is the expected RecordedRequest[] after the preceding check
    DOCS_WORKER: [] as RecordedRequest[],
    // SAFETY: HTTP value is the expected RecordedRequest[] after the preceding check
    ADMIN: [] as RecordedRequest[],
  };

  const stub = (binding: BindingName): Fetcher => {
    const fetcher = {
      fetch: async (input: Request | URL | string, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? input
            : new Request(input instanceof URL ? input.href : input, init);
        const url = new URL(request.url);
        calls[binding].push({
          pathname: url.pathname,
          search: url.search,
          method: request.method,
        });
        return new Response(`${binding}-ok`, { status: 200 });
      },
      // Test double only implements fetch; connect is unused by the router.
      connect: () => {
        throw new Error(`connect is not stubbed for ${binding}`);
      },
    };
    // SAFETY: test double supplies the Fetcher.fetch surface the router calls
    return fetcher as Fetcher;
  };

  return {
    calls,
    env: {
      SYNC_API: stub("SYNC_API"),
      DOCS_WORKER: stub("DOCS_WORKER"),
      ADMIN: stub("ADMIN"),
    },
  };
}

const request = (path: string) => {
  const { calls, env } = makeEnv();
  const response = router.request(path, {}, env);
  return { response, calls };
};

test("/api prefix is stripped before forwarding", async () => {
  const { response, calls } = request("https://df.example/api/v1/health");
  await response;
  expect(calls.SYNC_API.map((call) => call.pathname)).toEqual(["/v1/health"]);
});

test("bare /api forwards to root", async () => {
  const { response, calls } = request("https://df.example/api");
  await response;
  expect(calls.SYNC_API.map((call) => call.pathname)).toEqual(["/"]);
});

test("paperback paths forward to sync api with prefix stripped", async () => {
  const path = "https://df.example/paperback/extensions/0.9/stable/versioning.json";
  const { response, calls } = request(path);
  await response;
  expect(calls.SYNC_API[0]?.pathname).toBe("/extensions/0.9/stable/versioning.json");
  expect(calls.SYNC_API[0]?.search).toBe("");
});

test("known docs paths forward untouched to docs", async () => {
  const { response, calls } = request("https://df.example/architecture/");
  await response;
  expect(calls.DOCS_WORKER.map((call) => call.pathname)).toEqual(["/architecture/"]);
});

test("docs home and static assets forward to docs", async () => {
  for (const path of ["/", "/llms.txt", "/_astro/client.js", "/pagefind/pagefind.js"]) {
    const { response, calls } = request(`https://df.example${path}`);
    await response;
    expect(calls.DOCS_WORKER.map((call) => call.pathname)).toContain(path);
  }
});

test("unknown paths return 418 without hitting docs", async () => {
  const { response, calls } = request("https://df.example/blog/wp/v2/users");
  const resolved = await response;
  expect(resolved.status).toBe(418);
  expect(await resolved.text()).toBe("I'm a teapot");
  expect(calls.DOCS_WORKER).toEqual([]);
  expect(calls.SYNC_API).toEqual([]);
  expect(calls.ADMIN).toEqual([]);
});

test("/admin paths forward with prefix intact", async () => {
  const { response, calls } = request("https://df.example/admin/durable-objects");
  await response;
  expect(calls.ADMIN.map((call) => call.pathname)).toEqual(["/admin/durable-objects"]);
});
