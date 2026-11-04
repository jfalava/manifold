/** @effect-diagnostics asyncFunction:off */
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { errorMessage } from "@manifold/json";

import {
  pollManifoldDeviceSession,
  saveManifoldSession,
  startManifoldDeviceLogin,
} from "@/login/manifold";
import { waitForDeviceApproval } from "@/login/device-wait";
import { warnIfEnvOverridesLogin } from "@/login/status";
import { resolveValue } from "@/env-resolve";
import { abortFrame, closeFrame, openFrame } from "@/ui";
import { cliError } from "@/effect-kit";

const DEFAULT_API_ORIGIN = "https://manifold.jfa.dev/api";

export const manifoldLoginCommand = Command.make("manifold", {
  apiOrigin: Flag.String("api-origin").pipe(
    Flag.optional,
    Flag.withDescription(`Manifold API origin (default ${DEFAULT_API_ORIGIN}).`),
  ),
}).pipe(
  Command.withDescription(
    "Sign in to Manifold: approve the shown code in any browser with GitHub. Works on headless hosts.",
  ),
  Command.withHandler(({ apiOrigin }) =>
    Effect.tryPromise({
      try: async () => {
        const origin = resolveValue(apiOrigin, "MANIFOLD_API_ORIGIN") ?? DEFAULT_API_ORIGIN;
        openFrame("login manifold");
        const grant = await startManifoldDeviceLogin(origin);

        const session = await waitForDeviceApproval({
          providerLabel: "Manifold",
          userCode: grant.userCode,
          url: grant.verificationUriComplete,
          poll: (signal) => pollManifoldDeviceSession(origin, grant, signal),
        });

        await saveManifoldSession(session);
        closeFrame("Signed in with GitHub. Manifold session saved in the OS keychain.");
        warnIfEnvOverridesLogin("manifold");
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }).pipe(Effect.onError(() => Effect.sync(abortFrame))),
  ),
);
