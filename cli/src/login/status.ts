/**
 * Offline sign-in status for bare `manifold login`: keychain sessions and env
 * overrides only, no network calls.
 */
import { Effect, Option, Schema } from "effect";

import {
  decodeJsonOption,
  envString,
  epochMillisNow,
  fromPromise,
  parseJsonValue,
  runHost,
} from "@/effect-kit";
import { ANILIST_SECRET } from "@/login/anilist";
import { MAL_SECRET } from "@/login/mal-session";
import { MANIFOLD_SESSION_SECRET } from "@/login/manifold";
import { ui, writeOutput } from "@/ui";

/** The fields status needs from any stored session; extra keys are ignored. */
const StoredSession = Schema.Struct({
  expiresAt: Schema.Finite,
  refreshToken: Schema.optional(Schema.NonEmptyString),
});

export type LoginState =
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "renews" }
  | { readonly kind: "expires"; readonly at: number }
  | { readonly kind: "expired"; readonly at: number };

export type LoginStatus = {
  readonly provider: "manifold" | "anilist" | "mal";
  readonly label: string;
  readonly state: LoginState;
};

const PROVIDERS = [
  {
    provider: "manifold",
    label: "Manifold",
    secret: MANIFOLD_SESSION_SECRET,
    env: "MANIFOLD_TOKEN",
  },
  { provider: "anilist", label: "AniList", secret: ANILIST_SECRET, env: "MANIFOLD_ANILIST_TOKEN" },
  { provider: "mal", label: "MAL", secret: MAL_SECRET, env: "MANIFOLD_MAL_TOKEN" },
] as const;

const sessionState = (raw: string | null, now: number): LoginState => {
  if (!raw) {
    return { kind: "missing" };
  }

  let session: Option.Option<Schema.Schema.Type<typeof StoredSession>>;

  try {
    session = decodeJsonOption(StoredSession, parseJsonValue(raw));
  } catch {
    return { kind: "invalid" };
  }

  if (Option.isNone(session)) {
    return { kind: "invalid" };
  }

  // Manifold and MAL refresh on use; only a refresh-less session can lapse.
  if (session.value.refreshToken) {
    return { kind: "renews" };
  }

  return session.value.expiresAt <= now
    ? { kind: "expired", at: session.value.expiresAt }
    : { kind: "expires", at: session.value.expiresAt };
};

export const loadLoginStatus = (
  get: (ref: { service: string; name: string }) => Promise<string | null> = (ref) =>
    Bun.secrets.get(ref),
  now: number = epochMillisNow(),
): Promise<readonly LoginStatus[]> =>
  runHost(
    Effect.forEach(PROVIDERS, ({ provider, label, secret, env }) =>
      envString(env)
        ? Effect.succeed({ provider, label, state: { kind: "env" as const, variable: env } })
        : fromPromise(() => get(secret)).pipe(
            Effect.map((raw) => ({ provider, label, state: sessionState(raw, now) })),
          ),
    ),
  );

/** After a successful login: an env token still wins over the keychain session just saved. */
export const warnIfEnvOverridesLogin = (provider: LoginStatus["provider"]): void => {
  const env = PROVIDERS.find((entry) => entry.provider === provider)?.env;

  if (env !== undefined && envString(env)) {
    writeOutput(
      `${ui.warning(`${env} is set and overrides this login. Unset it to use the keychain session.`)}\n`,
    );
  }
};
