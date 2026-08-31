import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createMangaDexPasswordGrant,
  createMangaDexRefreshGrant,
  MANGADEX_TOKEN_ENDPOINT,
  type MangaDexPersonalClientCredentials
} from "@manifold/mangadex";

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

const loadPersistedTokens = async (
  cachePath: string | undefined,
): Promise<PersistedTokens> => {
  if (!cachePath) return {};
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as PersistedTokens;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
};

/**
 * Acquires and refreshes a MangaDex personal-client access token via the
 * password grant. Tokens are held in module scope per instance so a single
 * migration run reuses one session; pass cachePath to reuse them across runs.
 */
export const createMangaDexTokenManager = (
  options: MangaDexTokenManagerOptions,
) => {
  const fetcher = options.fetcher ?? fetch;
  const persisted = () => loadPersistedTokens(options.cachePath);
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let expiresAt = 0;

  const persistTokens = async (): Promise<void> => {
    if (!options.cachePath) return;
    const payload: PersistedTokens = { accessToken, refreshToken, expiresAt };
    await mkdir(dirname(options.cachePath), { recursive: true });
    await writeFile(options.cachePath, JSON.stringify(payload), { mode: 0o600 });
  };

  const requestToken = async (
    grant: URLSearchParams,
    label: string,
  ): Promise<void> => {
    const response = await fetcher(MANGADEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: grant.toString()
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `MangaDex ${label} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    const body = (await response.json()) as TokenResponse;
    if (!body.access_token) throw new Error(`MangaDex ${label} returned no access_token`);
    accessToken = body.access_token;
    refreshToken = body.refresh_token ?? refreshToken;
    expiresAt =
      Date.now() + (Number.isFinite(body.expires_in) ? Number(body.expires_in) : 900) * 1000 -
      EXPIRY_MARGIN_MS;
    await persistTokens();
  };

  return {
    /** Returns a cached token, refreshing or re-authenticating when needed. */
    current: async (): Promise<string> => {
      if (accessToken && Date.now() < expiresAt) return accessToken;
      if (!refreshToken && options.cachePath) {
        const stored = await persisted();
        accessToken = stored.accessToken;
        refreshToken = stored.refreshToken;
        expiresAt = Number.isFinite(stored.expiresAt) ? (stored.expiresAt as number) : 0;
        if (accessToken && Date.now() < expiresAt) return accessToken;
      }
      if (refreshToken) {
        try {
          await requestToken(
            createMangaDexRefreshGrant(options.credentials, refreshToken),
            "refresh grant"
          );
          return accessToken as string;
        } catch {
          // Fall through to a fresh password grant.
          refreshToken = undefined;
        }
      }
      await requestToken(createMangaDexPasswordGrant(options.credentials), "password grant");
      return accessToken as string;
    },
    /** Forces a fresh password grant on the next call. */
    invalidate: (): void => {
      accessToken = undefined;
      expiresAt = 0;
    }
  };
};

export type MangaDexTokenManager = ReturnType<typeof createMangaDexTokenManager>;
