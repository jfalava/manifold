/** @effect-diagnostics asyncFunction:off */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";

import {
  createManifoldAuthorization,
  exchangeManifoldCode,
  MANIFOLD_CLI_OAUTH_REDIRECT_URI,
  saveManifoldSession,
} from "@/login/manifold";
import { awaitOAuthAuthorizationCode } from "@/login/oauth-loopback";
import { resolveValue } from "@/env-resolve";
import { abortFrame, closeFrame, openFrame } from "@/ui";
import { cliError } from "@/effect-kit";

const DEFAULT_API_ORIGIN = "https://manifold.jfa.dev/api";

export const manifoldLoginCommand = Command.make("manifold", {
  apiOrigin: Flag.String("api-origin").pipe(
    Flag.optional,
    Flag.withDescription(`Manifold API origin (default ${DEFAULT_API_ORIGIN}).`),
  ),
  pasteOnly: Flag.Boolean("paste-only").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Skip the local callback server; paste the authorization code or callback URL (headless).",
    ),
  ),
}).pipe(
  Command.withDescription(
    `Authorize Manifold with GitHub; callback ${MANIFOLD_CLI_OAUTH_REDIRECT_URI}. Supports loopback or pasted code/URL.`,
  ),
  Command.withHandler(({ apiOrigin, pasteOnly }) =>
    Effect.tryPromise({
      try: async () => {
        const origin = resolveValue(apiOrigin, "MANIFOLD_API_ORIGIN") ?? DEFAULT_API_ORIGIN;
        openFrame("login manifold");
        const auth = await createManifoldAuthorization(origin);
        const code = await awaitOAuthAuthorizationCode({
          providerLabel: "Manifold",
          authorizeUrl: auth.url,
          redirectUri: MANIFOLD_CLI_OAUTH_REDIRECT_URI,
          expectedState: auth.state,
          pasteOnly,
        });
        const session = await exchangeManifoldCode(origin, code, auth.verifier);
        await saveManifoldSession(session);
        closeFrame("Signed in with GitHub. Manifold session saved in the OS keychain.");
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
