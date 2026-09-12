import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isFiniteNumber, isJsonObject, isString, manifoldUserAgent } from "@manifold/json";
import {
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT,
  type MangaDexPersonalClientCredentials,
} from "@manifold/mangadex";
import { Effect } from "effect";
import { epochMillisNow, fromPromise, jsonFromResponseEffect, runHost } from "@/effect-kit";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface MangaDexTokenManagerOptions {
  readonly credentials: MangaDexPersonalClientCredentials;
  readonly fetcher?: typeof fetch;
  /**
   * When set, tokens are persisted here and reused across runs: a stored
   * refresh token avoids re-minting password grants, which is what trips
   * MangaDex auth rate limits.
   */
  readonly cachePath?: string;
}

const EXPIRY_MARGIN_MS = 60_000;

interface PersistedTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

const loadPersistedTokensEffect = (cachePath: string | undefined): Effect.Effect<PersistedTokens> =>
  Effect.gen(function* () {
    if (!cachePath) {
      return {};
    }
    const outcome = yield* fromPromise(async () => {
      // SAFETY: token cache JSON is decoded via isJsonObject / field guards below
      const raw: unknown = JSON.parse(await readFile(cachePath, "utf8"));
      if (!isJsonObject(raw)) {
        return {} as PersistedTokens;
      }
      return {
        accessToken: isString(raw.accessToken) ? raw.accessToken : undefined,
        refreshToken: isString(raw.refreshToken) ? raw.refreshToken : undefined,
        expiresAt: isFiniteNumber(raw.expiresAt) ? raw.expiresAt : undefined,
      } satisfies PersistedTokens;
    }).pipe(Effect.option);
    if (outcome._tag === "None") {
      return {};
    }
    return outcome.value;
  });

/**
 * Acquires and refreshes a MangaDex personal-client access token via the
 * password grant. Tokens are held in module scope per instance so a single
 * migration run reuses one session; pass cachePath to reuse them across runs.
 */
export const createMangaDexTokenManager = (options: MangaDexTokenManagerOptions) => {
  const fetcher = options.fetcher ?? fetch;
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let expiresAt = 0;

  const persistTokensEffect = (): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      if (!options.cachePath) {
        return;
      }
      const payload: PersistedTokens = { accessToken, refreshToken, expiresAt };
      yield* fromPromise(async () => {
        await mkdir(dirname(options.cachePath!), { recursive: true });
        await writeFile(options.cachePath!, JSON.stringify(payload), { mode: 0o600 });
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error
            ? cause
            : new Error(`MangaDex token cache write failed: ${String(cause)}`),
        ),
      );
    });

  const requestTokenEffect = (grant: URLSearchParams, label: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const response = yield* fromPromise(() =>
        fetcher(MANGADEX_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": manifoldUserAgent("cli"),
          },
          body: grant.toString(),
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(`MangaDex ${label} failed: ${String(cause)}`),
        ),
      );
      if (!response.ok) {
        const detail = yield* fromPromise(() => response.text()).pipe(
          Effect.orElseSucceed(() => ""),
        );
        return yield* Effect.fail(
          new Error(
            `MangaDex ${label} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          ),
        );
      }
      const raw = yield* jsonFromResponseEffect(response, `mangadex.${label}`);
      // SAFETY: HTTP value is the expected TokenResponse after the preceding check
      const body = raw as TokenResponse;
      if (!body.access_token) {
        return yield* Effect.fail(new Error(`MangaDex ${label} returned no access_token`));
      }
      accessToken = body.access_token;
      refreshToken = body.refresh_token ?? refreshToken;
      expiresAt =
        epochMillisNow() +
        (Number.isFinite(body.expires_in) ? Number(body.expires_in) : 900) * 1000 -
        EXPIRY_MARGIN_MS;
      yield* persistTokensEffect();
    });

  const currentEffect = (): Effect.Effect<string, Error> =>
    Effect.gen(function* () {
      if (accessToken && epochMillisNow() < expiresAt) {
        return accessToken;
      }
      if (!refreshToken && options.cachePath) {
        const stored = yield* loadPersistedTokensEffect(options.cachePath);
        accessToken = stored.accessToken;
        refreshToken = stored.refreshToken;
        expiresAt = stored.expiresAt ?? 0;
        if (accessToken && epochMillisNow() < expiresAt) {
          return accessToken;
        }
      }
      if (refreshToken) {
        const refreshed = yield* requestTokenEffect(
          createMangaDexRefreshGrant(options.credentials, refreshToken),
          "refresh grant",
        ).pipe(
          Effect.map(() => true as const),
          Effect.orElseSucceed(() => false as const),
        );
        if (refreshed) {
          // SAFETY: value is a string after a successful requestTokenEffect
          return accessToken as string;
        }
        // Fall through to a fresh password grant.
        refreshToken = undefined;
      }
      yield* requestTokenEffect(createMangaDexPasswordGrant(options.credentials), "password grant");
      // SAFETY: value is a string after the preceding runtime check
      return accessToken as string;
    });

  return {
    /** Returns a cached token, refreshing or re-authenticating when needed. */
    current: (): Promise<string> => runHost(currentEffect()),
    /** Forces a fresh password grant on the next call. */
    invalidate: (): void => {
      accessToken = undefined;
      expiresAt = 0;
    },
  };
};

export type MangaDexTokenManager = ReturnType<typeof createMangaDexTokenManager>;
