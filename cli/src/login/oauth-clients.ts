/**
 * OAuth app client id/secret for CLI provider logins.
 *
 * Resolve order: flag → process env / cli/.env → OS keychain → interactive
 * prompt (TTY only). After a successful interactive capture, credentials are
 * stored in Bun.secrets so compiled binaries work without a .env file.
 *
 * Wizard mode (`wizard: true`) is used for bare `login anilist|mal` on a TTY:
 * prints setup/usage, then walks each value with Enter-to-keep defaults.
 */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { Effect, Option, Schema } from "effect";

import {
  cliError,
  decodeJsonOrThrow,
  fromPromise,
  parseJsonValue,
  runHost,
  type CliEffectError,
} from "@/effect-kit";
import { resolveValue } from "@/env-resolve";
import {
  confirmInFrame,
  frameDetail,
  promptInFrameWithDefault,
  promptSecretInFrame,
} from "@/ui";

export const OAUTH_CLIENT_SERVICE = "manifold";

export const ANILIST_OAUTH_CLIENT_SECRET = {
  service: OAUTH_CLIENT_SERVICE,
  name: "anilist-oauth-client",
} as const;

export const MAL_OAUTH_CLIENT_SECRET = {
  service: OAUTH_CLIENT_SERVICE,
  name: "mal-oauth-client",
} as const;

const StoredClient = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.optional(Schema.String),
});

export type StoredOAuthClient = Schema.Schema.Type<typeof StoredClient>;

export type OAuthClientKind = "anilist" | "mal";

const secretRef = (kind: OAuthClientKind) =>
  kind === "anilist" ? ANILIST_OAUTH_CLIENT_SECRET : MAL_OAUTH_CLIENT_SECRET;

const envNames = (kind: OAuthClientKind) =>
  kind === "anilist"
    ? {
        clientId: "MANIFOLD_ANILIST_CLIENT_ID",
        clientSecret: "MANIFOLD_ANILIST_CLIENT_SECRET",
      }
    : {
        clientId: "MANIFOLD_MAL_CLIENT_ID",
        clientSecret: "MANIFOLD_MAL_CLIENT_SECRET",
      };

const label = (kind: OAuthClientKind) => (kind === "anilist" ? "AniList" : "MAL");

const redirectUri = (kind: OAuthClientKind) =>
  kind === "anilist" ? "http://127.0.0.1:8767/callback" : "http://127.0.0.1:8766/callback";

const developerUrl = (kind: OAuthClientKind) =>
  kind === "anilist"
    ? "https://anilist.co/settings/developer"
    : "https://myanimelist.net/apiconfig";

export type OAuthClientSecretStore = {
  readonly get: (ref: { service: string; name: string }) => Promise<string | null>;
  readonly set: (ref: {
    service: string;
    name: string;
    value: string;
  }) => Promise<void>;
};

const defaultStore = (): OAuthClientSecretStore => ({
  get: (ref) => Bun.secrets.get(ref),
  set: (ref) => Bun.secrets.set(ref),
});

export const loadStoredOAuthClient = async (
  kind: OAuthClientKind,
  store: OAuthClientSecretStore = defaultStore(),
): Promise<StoredOAuthClient | undefined> => {
  const raw = await store.get(secretRef(kind));
  if (!raw) {
    return undefined;
  }
  try {
    return decodeJsonOrThrow(StoredClient, parseJsonValue(raw), `${kind}.oauth-client`);
  } catch {
    throw cliError(
      `Invalid ${label(kind)} OAuth client in the keychain. Re-run login ${kind} to replace it.`,
    );
  }
};

export const saveStoredOAuthClient = async (
  kind: OAuthClientKind,
  client: StoredOAuthClient,
  store: OAuthClientSecretStore = defaultStore(),
): Promise<void> => {
  let value: StoredOAuthClient = { clientId: client.clientId };
  if (client.clientSecret !== undefined && client.clientSecret.length > 0) {
    value = { clientId: client.clientId, clientSecret: client.clientSecret };
  }
  await store.set({ ...secretRef(kind), value: JSON.stringify(value) });
};

/** Setup + usage lines shown at the start of wizard / salvage flows. */
export const printOAuthClientWizardIntro = (kind: OAuthClientKind): void => {
  const names = envNames(kind);
  const provider = label(kind);
  frameDetail(`${provider} login wizard`);
  frameDetail(`1. Create a separate ${provider} OAuth app at ${developerUrl(kind)}`);
  frameDetail(`2. Set redirect URI exactly: ${redirectUri(kind)}`);
  frameDetail(
    `3. Client id/secret: flags, ${names.clientId}/${names.clientSecret}, keychain, or prompts below`,
  );
  if (kind === "anilist") {
    frameDetail("Do not reuse app 49218 or Worker 49060 — need authorization-code + loopback.");
  } else {
    frameDetail("Do not reuse the deployed API MAL client — CLI needs its own redirect URI.");
  }
  frameDetail(
    `Usage: manifold login ${kind} [--client-id …] [--client-secret …] [--paste-only]`,
  );
  frameDetail(`Also: manifold --wizard login ${kind}  (Effect CLI walks every flag)`);
  frameDetail("Enter keeps a shown default. Ctrl+C cancels.");
};

export type ResolveOAuthClientInput = {
  readonly kind: OAuthClientKind;
  readonly clientIdFlag: Option.Option<string>;
  readonly clientSecretFlag: Option.Option<string>;
  /** When true, clientSecret must be non-empty after resolution. */
  readonly requireSecret: boolean;
  /**
   * Guided mode: print usage and prompt every field (Enter keeps defaults from
   * flag/env/keychain). Used for bare `login anilist|mal` on a TTY.
   */
  readonly wizard?: boolean;
  readonly store?: OAuthClientSecretStore;
  /** Injected for tests; defaults to process.stdin.isTTY. */
  readonly isTty?: boolean;
  readonly promptWithDefault?: (message: string, defaultValue?: string) => Promise<string>;
  readonly promptSecret?: (message: string) => Promise<string>;
};

export type ResolvedOAuthClient = {
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  /** True when credentials were typed or confirmed interactively this run. */
  readonly prompted: boolean;
};

const maskSecret = (value: string): string => {
  if (value.length <= 4) {
    return "****";
  }
  return `${value.slice(0, 2)}…${value.slice(-2)} (${value.length} chars)`;
};

const persistClient = (
  kind: OAuthClientKind,
  clientId: string,
  clientSecret: string | undefined,
  store: OAuthClientSecretStore,
): Effect.Effect<void, CliEffectError> => {
  if (clientSecret !== undefined && clientSecret.length > 0) {
    return fromPromise(() =>
      saveStoredOAuthClient(kind, { clientId, clientSecret }, store),
    );
  }
  return fromPromise(() => saveStoredOAuthClient(kind, { clientId }, store));
};

const resolveOAuthClientEffect = (
  input: ResolveOAuthClientInput,
): Effect.Effect<ResolvedOAuthClient, CliEffectError> =>
  Effect.gen(function* () {
    const names = envNames(input.kind);
    const store = input.store ?? defaultStore();
    const isTty = input.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const promptWithDefault = input.promptWithDefault ?? promptInFrameWithDefault;
    const promptSecret = input.promptSecret ?? promptSecretInFrame;
    const wizard = input.wizard === true;

    let clientId = resolveValue(input.clientIdFlag, names.clientId);
    let clientSecret = resolveValue(input.clientSecretFlag, names.clientSecret);
    let fromKeychain = false;

    {
      const stored = yield* fromPromise(() => loadStoredOAuthClient(input.kind, store));
      if (stored) {
        clientId = clientId ?? stored.clientId;
        clientSecret = clientSecret ?? stored.clientSecret;
        fromKeychain = true;
        if (!wizard) {
          frameDetail(`${label(input.kind)} OAuth client loaded from the OS keychain.`);
        }
      }
    }

    const missingId = !clientId || clientId.length === 0;
    const missingSecret = input.requireSecret && (!clientSecret || clientSecret.length === 0);
    const needsInteractive = wizard || missingId || missingSecret;

    if (!needsInteractive) {
      return {
        clientId: clientId!,
        clientSecret: clientSecret && clientSecret.length > 0 ? clientSecret : undefined,
        prompted: false,
      };
    }

    if (!isTty) {
      return yield* cliError(
        [
          `Missing ${label(input.kind)} OAuth client credentials.`,
          `Set ${names.clientId}` +
            (input.requireSecret ? ` and ${names.clientSecret}` : "") +
            `, pass --client-id` +
            (input.requireSecret ? " / --client-secret" : "") +
            `, or run login ${input.kind} on a TTY to walk the wizard and save them in the OS keychain.`,
        ].join(" "),
      );
    }

    printOAuthClientWizardIntro(input.kind);
    if (fromKeychain || clientId || clientSecret) {
      frameDetail("Defaults from flag/env/keychain are shown — press Enter to keep.");
    }

    // --- client id ---
    {
      const next = (
        yield* fromPromise(() =>
          promptWithDefault(`${label(input.kind)} client id`, clientId),
        )
      ).trim();
      if (next.length === 0) {
        return yield* cliError(`${label(input.kind)} client id is required.`);
      }
      clientId = next;
    }

    // --- client secret ---
    if (clientSecret && clientSecret.length > 0) {
      frameDetail(
        `${label(input.kind)} client secret on file: ${maskSecret(clientSecret)}. Blank keeps it.`,
      );
      const replacement = (
        yield* fromPromise(() =>
          promptSecret(`${label(input.kind)} client secret (blank keeps existing)`),
        )
      ).trim();
      if (replacement.length > 0) {
        clientSecret = replacement;
      }
    } else {
      const asked = (
        yield* fromPromise(() =>
          promptSecret(
            input.requireSecret
              ? `${label(input.kind)} client secret`
              : `${label(input.kind)} client secret (optional, Enter to skip)`,
          ),
        )
      ).trim();
      if (asked.length > 0) {
        clientSecret = asked;
      } else if (input.requireSecret) {
        return yield* cliError(`${label(input.kind)} client secret is required.`);
      } else {
        clientSecret = undefined;
      }
    }

    yield* persistClient(input.kind, clientId, clientSecret, store);
    frameDetail(`${label(input.kind)} OAuth client saved in the OS keychain.`);

    return {
      clientId,
      clientSecret: clientSecret && clientSecret.length > 0 ? clientSecret : undefined,
      prompted: true,
    };
  });

export const resolveOAuthClient = (input: ResolveOAuthClientInput): Promise<ResolvedOAuthClient> =>
  runHost(resolveOAuthClientEffect(input));

/**
 * Ask paste-only in wizard mode. Returns existing value when not wizard.
 */
export const resolvePasteOnlyWizard = async (
  current: boolean,
  wizard: boolean,
  options?: {
    readonly isTty?: boolean;
    readonly confirm?: (message: string) => Promise<boolean>;
  },
): Promise<boolean> => {
  if (!wizard) {
    return current;
  }
  const isTty = options?.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTty) {
    return current;
  }
  frameDetail(
    "paste-only: skip local callback server (SSH/headless). Open the authorize URL elsewhere, then paste code/URL.",
  );
  const confirm = options?.confirm ?? confirmInFrame;
  return confirm("Use --paste-only mode?");
};

/** True when the user invoked login without any credential/paste flags (bare command). */
export const isBareLoginInvocation = (
  clientId: Option.Option<string>,
  clientSecret: Option.Option<string>,
  pasteOnly: boolean,
): boolean => Option.isNone(clientId) && Option.isNone(clientSecret) && pasteOnly === false;
