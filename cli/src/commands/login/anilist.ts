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
import { awaitOAuthAuthorizationCode } from "@/login/oauth-loopback";
import { resolveValue } from "@/env-resolve";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import { cliError, envString } from "@/effect-kit";

/** OAuth server and callback are Promise-based host APIs. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */

export const anilistLoginCommand = Command.make("anilist", {
  clientId: Flag.String("client-id").pipe(
    Flag.optional,
    Flag.withDescription("AniList CLI client ID. Falls back to MANIFOLD_ANILIST_CLIENT_ID."),
  ),
  pasteOnly: Flag.Boolean("paste-only").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Skip the local callback server; paste the authorization code or callback URL (headless).",
    ),
  ),
}).pipe(
  Command.withDescription(
    `Authorize AniList locally. Register ${ANILIST_REDIRECT_URI} on a separate authorization-code client. Supports loopback callback or pasted code/URL.`,
  ),
  Command.withHandler(({ clientId, pasteOnly }) =>
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
        const code = await awaitOAuthAuthorizationCode({
          providerLabel: "AniList",
          authorizeUrl: auth.url,
          redirectUri: ANILIST_REDIRECT_URI,
          expectedState: auth.state,
          pasteOnly,
        });
        const session = await exchangeAniListCode(id, secret, code);
        const viewer = await validateAniListSession(session.accessToken);
        await Bun.secrets.set({ ...ANILIST_SECRET, value: JSON.stringify(session) });
        closeFrame(`Signed in as ${viewer.name} (${viewer.id}). Token saved in the OS keychain.`);
        if (envString("MANIFOLD_ANILIST_TOKEN")) {
          frameDetail(
            "MANIFOLD_ANILIST_TOKEN is set and overrides this login. Unset it to use the keychain token.",
          );
        }
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
