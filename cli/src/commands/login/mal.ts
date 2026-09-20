import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";

import { saveMalSession } from "@/login/mal-session";
import { resolveOAuthClient } from "@/login/oauth-clients";
import { awaitOAuthAuthorizationCode } from "@/login/oauth-loopback";
import { createMalAuthorization, createMalClient, MAL_REDIRECT_URI, requestMalTokens } from "@/mal";
import { abortFrame, closeFrame, openFrame } from "@/ui";
import { cliError } from "@/effect-kit";

/** OAuth server and callback are Promise-based host APIs. */
/** @effect-diagnostics asyncFunction:off */

export const malLoginCommand = Command.make("mal", {
  clientId: Flag.String("client-id").pipe(
    Flag.optional,
    Flag.withDescription(
      "MAL OAuth client ID. Falls back to MANIFOLD_MAL_CLIENT_ID, then OS keychain, then interactive prompt.",
    ),
  ),
  clientSecret: Flag.String("client-secret").pipe(
    Flag.optional,
    Flag.withDescription(
      "MAL OAuth client secret when required. Falls back to MANIFOLD_MAL_CLIENT_SECRET, then OS keychain, then interactive prompt.",
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
    `Authorize MAL locally; register ${MAL_REDIRECT_URI} as the OAuth redirect URI. Supports loopback callback or pasted code/URL. OAuth client id/secret may live in env, keychain, or an interactive prompt.`,
  ),
  Command.withHandler(({ clientId, clientSecret, pasteOnly }) =>
    Effect.tryPromise({
      try: async () => {
        openFrame("login mal");
        const oauth = await resolveOAuthClient({
          kind: "mal",
          clientIdFlag: clientId,
          clientSecretFlag: clientSecret,
          requireSecret: false,
        });
        const auth = createMalAuthorization(oauth.clientId);
        const code = await awaitOAuthAuthorizationCode({
          providerLabel: "MAL",
          authorizeUrl: auth.url,
          redirectUri: MAL_REDIRECT_URI,
          expectedState: auth.state,
          pasteOnly,
        });
        const session = await requestMalTokens(
          oauth.clientId,
          oauth.clientSecret,
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
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
