/**
 * OAuth app client id/secret for CLI provider logins.
 *
 * Resolve order: flag → process env / cli/.env → OS keychain → interactive
 * prompt (TTY only). After a successful interactive capture, credentials are
 * stored in Bun.secrets so compiled binaries work without a .env file.
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
import { frameDetail, promptInFrame, promptSecretInFrame } from "@/ui";

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

export type ResolveOAuthClientInput = {
  readonly kind: OAuthClientKind;
  readonly clientIdFlag: Option.Option<string>;
  readonly clientSecretFlag: Option.Option<string>;
  /** When true, clientSecret must be non-empty after resolution. */
  readonly requireSecret: boolean;
  readonly store?: OAuthClientSecretStore;
  /** Injected for tests; defaults to process.stdin.isTTY. */
  readonly isTty?: boolean;
  readonly prompt?: (message: string) => Promise<string>;
  readonly promptSecret?: (message: string) => Promise<string>;
};

export type ResolvedOAuthClient = {
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  /** True when credentials were typed interactively this run. */
  readonly prompted: boolean;
};

const resolveOAuthClientEffect = (
  input: ResolveOAuthClientInput,
): Effect.Effect<ResolvedOAuthClient, CliEffectError> =>
  Effect.gen(function* () {
    const names = envNames(input.kind);
    const store = input.store ?? defaultStore();
    const isTty = input.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const prompt = input.prompt ?? promptInFrame;
    const promptSecret = input.promptSecret ?? promptSecretInFrame;

    let clientId = resolveValue(input.clientIdFlag, names.clientId);
    let clientSecret = resolveValue(input.clientSecretFlag, names.clientSecret);
    let prompted = false;

    if (!clientId || (input.requireSecret && !clientSecret)) {
      const stored = yield* fromPromise(() => loadStoredOAuthClient(input.kind, store));
      if (stored) {
        clientId = clientId ?? stored.clientId;
        clientSecret = clientSecret ?? stored.clientSecret;
        frameDetail(`${label(input.kind)} OAuth client loaded from the OS keychain.`);
      }
    }

    if (!clientId || (input.requireSecret && !clientSecret)) {
      if (!isTty) {
        return yield* cliError(
          [
            `Missing ${label(input.kind)} OAuth client credentials.`,
            `Set ${names.clientId}` +
              (input.requireSecret ? ` and ${names.clientSecret}` : "") +
              `, pass --client-id` +
              (input.requireSecret ? " / --client-secret" : "") +
              `, or run login ${input.kind} on a TTY to save them in the OS keychain.`,
          ].join(" "),
        );
      }

      frameDetail(
        `No ${label(input.kind)} OAuth client in env or keychain. Enter the CLI app credentials once; they will be saved in the OS keychain.`,
      );
      if (!clientId) {
        clientId = (yield* fromPromise(() =>
          prompt(`${label(input.kind)} client id`),
        )).trim();
      }
      if (input.requireSecret && !clientSecret) {
        clientSecret = (yield* fromPromise(() =>
          promptSecret(`${label(input.kind)} client secret`),
        )).trim();
      } else if (!input.requireSecret && clientSecret === undefined) {
        const optional = (yield* fromPromise(() =>
          promptSecret(`${label(input.kind)} client secret (optional, Enter to skip)`),
        )).trim();
        clientSecret = optional.length > 0 ? optional : undefined;
      }
      prompted = true;
    }

    if (!clientId || clientId.length === 0) {
      return yield* cliError(`${label(input.kind)} client id is required.`);
    }
    if (input.requireSecret && (!clientSecret || clientSecret.length === 0)) {
      return yield* cliError(`${label(input.kind)} client secret is required.`);
    }

    if (prompted) {
      const toStore: StoredOAuthClient = { clientId };
      if (clientSecret !== undefined && clientSecret.length > 0) {
        // Build separately so secret is omitted when empty (anti-slop).
        const withSecret: StoredOAuthClient = {
          clientId,
          clientSecret,
        };
        yield* fromPromise(() => saveStoredOAuthClient(input.kind, withSecret, store));
      } else {
        yield* fromPromise(() => saveStoredOAuthClient(input.kind, toStore, store));
      }
      frameDetail(`${label(input.kind)} OAuth client saved in the OS keychain.`);
    }

    return {
      clientId,
      clientSecret: clientSecret && clientSecret.length > 0 ? clientSecret : undefined,
      prompted,
    };
  });

export const resolveOAuthClient = (input: ResolveOAuthClientInput): Promise<ResolvedOAuthClient> =>
  runHost(resolveOAuthClientEffect(input));
