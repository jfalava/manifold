import { expect, test } from "bun:test";

import { resolveSecret, runHost } from "../src/lib/effect-host";

/** Mimics a Workers RPC stub: every property read is a remote method, `get` included. */
const rpcStub = (secret: string) => {
  const method = (name: string): (() => Promise<string>) =>
    new Proxy((): Promise<string> => Promise.resolve(""), {
      get: (_target, property) => method(String(property)),
      apply: () =>
        name === "get"
          ? Promise.resolve(secret)
          : Promise.reject(new Error(`The RPC receiver does not implement the method "${name}".`)),
    });

  return new Proxy({}, { get: (_target, property) => method(String(property)) });
};

test("reads a Secrets Store binding by calling get on the stub", async () => {
  await expect(runHost(resolveSecret(rpcStub("mf_token")))).resolves.toBe("mf_token");
});

test("passes plain string secrets through", async () => {
  await expect(runHost(resolveSecret("plain"))).resolves.toBe("plain");
});
