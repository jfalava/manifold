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
import {
  isBareLoginInvocation,
  resolveOAuthClient,
  resolvePasteOnlyWizard,
} from "@/login/oauth-clients";
import { awaitOAuthAuthorizationCode } from "@/login/oauth-loopback";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";
import { cliError, envString } from "@/effect-kit";

/** OAuth server and callback are Promise-based host APIs. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */

export const anilistLoginCommand = Command.make("anilist", {
  clientId: Flag.String("client-id").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList CLI client ID. Falls back to MANIFOLD_ANILIST_CLIENT_ID, then OS keychain, then interactive prompt.",
    ),
  ),
  clientSecret: Flag.String("client-secret").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList CLI client secret. Falls back to MANIFOLD_ANILIST_CLIENT_SECRET, then OS keychain, then interactive prompt.",
    ),
  ),
  pasteOnly: Flag.Boolean("paste-only").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Skip the local callback server; paste the authorization code or callback URL (headless).",
    ),
  ),
}).pipe(
  Command.withDescription(
    `Authorize AniList locally. Register ${ANILIST_REDIRECT_URI} on a separate authorization-code client. Bare invocation on a TTY runs a setup wizard; --wizard walks Effect CLI flags. OAuth client id/secret: env, keychain, or prompts.`,
  ),
  Command.withHandler(({ clientId, clientSecret, pasteOnly }) =>
    Effect.tryPromise({
      try: async () => {
        openFrame("login anilist");
        const wizard = isBareLoginInvocation(clientId, clientSecret, pasteOnly);
        const oauth = await resolveOAuthClient({
          kind: "anilist",
          clientIdFlag: clientId,
          clientSecretFlag: clientSecret,
          requireSecret: true,
          wizard,
        });
        if (!oauth.clientSecret) {
          throw cliError("AniList client secret is required.");
        }
        const usePasteOnly = await resolvePasteOnlyWizard(pasteOnly, wizard);
        const auth = createAniListAuthorization(oauth.clientId);
        const code = await awaitOAuthAuthorizationCode({
          providerLabel: "AniList",
          authorizeUrl: auth.url,
          redirectUri: ANILIST_REDIRECT_URI,
          expectedState: auth.state,
          pasteOnly: usePasteOnly,
        });
        const session = await exchangeAniListCode(oauth.clientId, oauth.clientSecret, code);
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
