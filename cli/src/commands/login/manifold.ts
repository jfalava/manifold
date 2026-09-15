/** @effect-diagnostics asyncFunction:off */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  createManifoldAuthorization,
  exchangeManifoldCode,
  MANIFOLD_CLI_OAUTH_REDIRECT_URI,
  saveManifoldSession,
} from "@/login/manifold";
import { resolveValue } from "@/env-resolve";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import { cliError, sleepPromise } from "@/effect-kit";

const DEFAULT_API_ORIGIN = "https://manifold.jfa.dev/api";

export const manifoldLoginCommand = Command.make("manifold", {
  apiOrigin: Flag.String("api-origin").pipe(
    Flag.optional,
    Flag.withDescription(`Manifold API origin (default ${DEFAULT_API_ORIGIN}).`),
  ),
}).pipe(
  Command.withDescription(
    `Authorize Manifold with GitHub locally; callback ${MANIFOLD_CLI_OAUTH_REDIRECT_URI}.`,
  ),
  Command.withHandler(({ apiOrigin }) =>
    Effect.tryPromise({
      try: async () => {
        const origin = resolveValue(apiOrigin, "MANIFOLD_API_ORIGIN") ?? DEFAULT_API_ORIGIN;
        openFrame("login manifold");
        const auth = await createManifoldAuthorization(origin);
        const callback = Promise.withResolvers<string>();
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 8768,
          fetch(request: Request) {
            const url = new URL(request.url);
            const headers = { "content-type": "text/plain", "cache-control": "no-store" };
            if (request.method !== "GET" || url.pathname !== "/callback") {
              return new Response("Not found", { status: 404, headers });
            }
            if (url.searchParams.get("state") !== auth.state) {
              return new Response("Invalid OAuth state", { status: 400, headers });
            }
            if (url.searchParams.has("error")) {
              callback.reject(cliError("Manifold GitHub authorization denied."));
              return new Response("Authorization denied. Return to the CLI.", { headers });
            }
            const code = url.searchParams.get("code");
            if (!code) {
              return new Response("Missing authorization code", { status: 400, headers });
            }
            callback.resolve(code);
            return new Response("Authorization received. Return to the CLI to check the result.", {
              headers,
            });
          },
        });
        let timedOut = false;
        void sleepPromise(300_000).then(() => {
          if (!timedOut) {
            timedOut = true;
            callback.reject(cliError("Manifold login timed out after five minutes."));
          }
        });
        try {
          frameDetail(`Callback URL: ${MANIFOLD_CLI_OAUTH_REDIRECT_URI}`);
          frameDetail(`Open this URL in your browser:\n${auth.url}`);
          const session = await exchangeManifoldCode(origin, await callback.promise, auth.verifier);
          await saveManifoldSession(session);
          closeFrame("Signed in with GitHub. Manifold session saved in the OS keychain.");
        } finally {
          timedOut = true;
          await server.stop(true);
        }
      },
      catch: (cause) => cliError(cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
