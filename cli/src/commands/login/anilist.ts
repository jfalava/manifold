import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";
import {
  ANILIST_REDIRECT_URI,
  ANILIST_SECRET,
  createAniListAuthorization,
  exchangeAniListCode,
  validateAniListSession,
} from "@/login/anilist";
import { resolveValue } from "@/env-resolve";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import { cliError, envString, sleepPromise } from "@/effect-kit";

/** OAuth server and callback are Promise-based host APIs. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */

export const anilistLoginCommand = Command.make("anilist", {
  clientId: Flag.String("client-id").pipe(
    Flag.optional,
    Flag.withDescription("AniList CLI client ID. Falls back to MANIFOLD_ANILIST_CLIENT_ID."),
  ),
}).pipe(
  Command.withDescription(
    `Authorize AniList locally. Register ${ANILIST_REDIRECT_URI} on a separate authorization-code client.`,
  ),
  Command.withHandler(({ clientId }) =>
    Effect.tryPromise({
      try: async () => {
        const id = resolveValue(clientId, "MANIFOLD_ANILIST_CLIENT_ID");
        const secret = envString("MANIFOLD_ANILIST_CLIENT_SECRET");
        if (!id || !secret) {
          throw cliError(
            "Set MANIFOLD_ANILIST_CLIENT_ID and MANIFOLD_ANILIST_CLIENT_SECRET for the CLI OAuth application.",
          );
        }
        openFrame("login anilist");
        const auth = createAniListAuthorization(id);
        const callback = Promise.withResolvers<string>();
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 8767,
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
              callback.reject(cliError("AniList authorization denied."));
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
            callback.reject(cliError("AniList login timed out after five minutes."));
          }
        });
        try {
          frameDetail(`Callback URL: ${ANILIST_REDIRECT_URI}`);
          frameDetail(`Open this URL in your browser:\n${auth.url}`);
          const session = await exchangeAniListCode(id, secret, await callback.promise);
          const viewer = await validateAniListSession(session.accessToken);
          await Bun.secrets.set({ ...ANILIST_SECRET, value: JSON.stringify(session) });
          closeFrame(`Signed in as ${viewer.name} (${viewer.id}). Token saved in the OS keychain.`);
          if (envString("MANIFOLD_ANILIST_TOKEN")) {
            frameDetail(
              "MANIFOLD_ANILIST_TOKEN is set and overrides this login. Unset it to use the keychain token.",
            );
          }
        } finally {
          timedOut = true;
          await server.stop(true);
        }
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
