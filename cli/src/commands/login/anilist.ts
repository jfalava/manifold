import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { errorMessage } from "@manifold/json";
import {
  ANILIST_REDIRECT_URI,
  ANILIST_SECRET,
  createAniListAuthorization,
  exchangeAniListCode,
  validateAniListSession,
} from "@/login/anilist";
import { resolveOAuthClient } from "@/login/oauth-clients";
import { awaitOAuthAuthorizationCode } from "@/login/oauth-loopback";
import { warnIfEnvOverridesLogin } from "@/login/status";
import { abortFrame, closeFrame, openFrame } from "@/ui";
import { cliError } from "@/effect-kit";

/** OAuth server and callback are Promise-based host APIs. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */

export const anilistLoginCommand = Command.make("anilist", {
  clientId: Flag.String("client-id").pipe(
    Flag.optional,
    Flag.withDescription(
      `AniList OAuth app client ID; the app's redirect URI must be ${ANILIST_REDIRECT_URI}. Falls back to MANIFOLD_ANILIST_CLIENT_ID, then OS keychain, then interactive prompt.`,
    ),
  ),
  clientSecret: Flag.String("client-secret").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList CLI client secret. Falls back to MANIFOLD_ANILIST_CLIENT_SECRET, then OS keychain, then interactive prompt.",
    ),
  ),
  reconfigure: Flag.Boolean("reconfigure").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Re-enter the OAuth app client id and secret even when they are saved."),
  ),
  pasteOnly: Flag.Boolean("paste-only").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Skip the local callback server; paste the authorization code or callback URL (headless).",
    ),
  ),
}).pipe(
  Command.withDescription("Sign in to AniList with your own OAuth app."),
  Command.withHandler(({ clientId, clientSecret, reconfigure, pasteOnly }) =>
    Effect.tryPromise({
      try: async () => {
        openFrame("login anilist");

        const oauth = await resolveOAuthClient({
          kind: "anilist",
          clientIdFlag: clientId,
          clientSecretFlag: clientSecret,
          requireSecret: true,
          wizard: reconfigure,
        });

        if (!oauth.clientSecret) {
          throw cliError("AniList client secret is required.");
        }

        const auth = createAniListAuthorization(oauth.clientId);

        const code = await awaitOAuthAuthorizationCode({
          providerLabel: "AniList",
          authorizeUrl: auth.url,
          redirectUri: ANILIST_REDIRECT_URI,
          expectedState: auth.state,
          pasteOnly,
        });

        const session = await exchangeAniListCode(oauth.clientId, oauth.clientSecret, code);
        const viewer = await validateAniListSession(session.accessToken);
        await Bun.secrets.set({ ...ANILIST_SECRET, value: JSON.stringify(session) });
        closeFrame(`Signed in as ${viewer.name} (${viewer.id}). Token saved in the OS keychain.`);
        warnIfEnvOverridesLogin("anilist");
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
