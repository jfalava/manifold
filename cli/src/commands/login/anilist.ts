/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
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
        const secret = process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
        if (!id || !secret) {
          throw new Error(
            "Set MANIFOLD_ANILIST_CLIENT_ID and MANIFOLD_ANILIST_CLIENT_SECRET for the CLI OAuth application.",
          );
        }
        openFrame("login anilist");
        const auth = createAniListAuthorization(id);
        const callback = Promise.withResolvers<string>();
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 8767,
          fetch(request) {
            const url = new URL(request.url);
            const headers = { "content-type": "text/plain", "cache-control": "no-store" };
            if (request.method !== "GET" || url.pathname !== "/callback") {
              return new Response("Not found", { status: 404, headers });
            }
            if (url.searchParams.get("state") !== auth.state) {
              return new Response("Invalid OAuth state", { status: 400, headers });
            }
            if (url.searchParams.has("error")) {
              callback.reject(new Error("AniList authorization denied."));
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
        const timer = setTimeout(
          () => callback.reject(new Error("AniList login timed out after five minutes.")),
          300_000,
        );
        try {
          frameDetail(`Callback URL: ${ANILIST_REDIRECT_URI}`);
          frameDetail(`Open this URL in your browser:\n${auth.url}`);
          const session = await exchangeAniListCode(id, secret, await callback.promise);
          const viewer = await validateAniListSession(session.accessToken);
          await Bun.secrets.set({ ...ANILIST_SECRET, value: JSON.stringify(session) });
          closeFrame(`Signed in as ${viewer.name} (${viewer.id}). Token saved in the OS keychain.`);
          if (process.env.MANIFOLD_ANILIST_TOKEN) {
            frameDetail(
              "MANIFOLD_ANILIST_TOKEN is set and overrides this login. Unset it to use the keychain token.",
            );
          }
        } finally {
          clearTimeout(timer);
          await server.stop(true);
        }
      },
      catch: (cause) => new Error(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
