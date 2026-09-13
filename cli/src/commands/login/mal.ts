import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";

import { saveMalSession } from "@/login/mal-session";
import { resolveValue } from "@/env-resolve";
import { createMalAuthorization, createMalClient, MAL_REDIRECT_URI, requestMalTokens } from "@/mal";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import { cliError, envString, sleepPromise } from "@/effect-kit";

/** OAuth server and callback are Promise-based host APIs. */
/** @effect-diagnostics asyncFunction:off */

export const malLoginCommand = Command.make("mal", {
  clientId: Flag.String("client-id").pipe(
    Flag.optional,
    Flag.withDescription("MAL OAuth client ID. Falls back to MANIFOLD_MAL_CLIENT_ID."),
  ),
}).pipe(
  Command.withDescription(
    `Authorize MAL locally; register ${MAL_REDIRECT_URI} as the OAuth redirect URI.`,
  ),
  Command.withHandler(({ clientId }) =>
    Effect.tryPromise({
      try: async () => {
        const id = resolveValue(clientId, "MANIFOLD_MAL_CLIENT_ID");
        if (!id) {
          throw cliError("Set MANIFOLD_MAL_CLIENT_ID or pass --client-id.");
        }
        openFrame("login mal");
        const auth = createMalAuthorization(id);
        const callback = Promise.withResolvers<string>();
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 8766,
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
              callback.reject(cliError("MAL authorization denied."));
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
            callback.reject(cliError("MAL login timed out after five minutes."));
          }
        });
        try {
          frameDetail(`Open this URL in your browser:\n${auth.url}`);
          const code = await callback.promise;
          const session = await requestMalTokens(
            id,
            envString("MANIFOLD_MAL_CLIENT_SECRET"),
            new URLSearchParams({
              grant_type: "authorization_code",
              code,
              code_verifier: auth.verifier,
              redirect_uri: MAL_REDIRECT_URI,
            }),
          );
          const profile = await createMalClient({ accessToken: session.accessToken }).profile();
          await saveMalSession(session);
          closeFrame(
            `Signed in as ${profile.name} (${profile.id}). Tokens saved in the OS keychain.`,
          );
        } finally {
          timedOut = true;
          await server.stop(true);
        }
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
