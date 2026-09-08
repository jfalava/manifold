import { Schema } from "effect";
import { manifoldUserAgent } from "@manifold/json";

const API = "https://api.myanimelist.net/v2";
const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
export const MAL_REDIRECT_URI = "http://127.0.0.1:8766/callback";
const USER_AGENT = manifoldUserAgent("cli");

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.Number,
});
export const MalSession = Schema.Struct({
  clientId: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.optional(Schema.NonEmptyString),
  expiresAt: Schema.Number,
});
export type MalSession = Schema.Schema.Type<typeof MalSession>;
const Profile = Schema.Struct({ id: Schema.Int, name: Schema.NonEmptyString });
const MangaPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      node: Schema.Struct({ id: Schema.Int, title: Schema.NonEmptyString }),
    }),
  ),
  paging: Schema.Struct({ next: Schema.optional(Schema.NonEmptyString) }),
});
export interface MalManga {
  readonly id: number;
  readonly title: string;
}

/** MAL wire fields. Source-specific conversion belongs in the importer. */
export interface MalMangaUpdate {
  readonly status?: "reading" | "completed" | "on_hold" | "dropped" | "plan_to_read";
  readonly is_rereading?: boolean;
  readonly score?: number;
  readonly num_volumes_read?: number;
  readonly num_chapters_read?: number;
  readonly priority?: number;
  readonly num_times_reread?: number;
  readonly reread_value?: number;
  readonly tags?: string;
  readonly comments?: string;
}

export const createMalAuthorization = (clientId: string) => {
  const verifier =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const state = crypto.randomUUID();
  const url = new URL("https://myanimelist.net/v1/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: MAL_REDIRECT_URI,
    state,
    code_challenge: verifier,
    code_challenge_method: "plain",
  }).toString();
  return { url: url.href, verifier, state };
};

export const requestMalTokens = async (
  clientId: string,
  clientSecret: string | undefined,
  grant: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Promise<MalSession> => {
  grant.set("client_id", clientId);
  if (clientSecret) {
    grant.set("client_secret", clientSecret);
  }
  // Do not retry token exchange: a lost response may have rotated the refresh token.
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: grant,
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`MAL token exchange failed: HTTP ${response.status}. Run login mal again.`);
  }
  // Schema errors can include the received payload. Never expose token responses.
  const tokens = await response
    .json()
    .then((body) => Schema.decodeUnknownSync(Tokens)(body))
    .catch(() => {
      throw new Error("MAL returned an invalid token response. Run login mal again.");
    });
  return {
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
};

/** One instance is used sequentially by each CLI operation. */
export const createMalClient = (options: {
  readonly accessToken?: string;
  readonly session?: MalSession;
  readonly clientSecret?: string;
  readonly saveSession?: (session: MalSession) => Promise<void>;
  readonly fetcher?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}) => {
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let session = options.session;
  let token = options.accessToken ?? session?.accessToken;
  let requested = false;

  const refresh = async (): Promise<void> => {
    if (options.accessToken || !session?.refreshToken) {
      throw new Error("MAL token expired. Run login mal or replace MANIFOLD_MAL_TOKEN.");
    }
    const next = await requestMalTokens(
      session.clientId,
      options.clientSecret,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }),
      fetcher,
    );
    session = { ...next, refreshToken: next.refreshToken ?? session.refreshToken };
    token = session.accessToken;
    await options.saveSession?.(session);
  };

  const request = async (
    path: string,
    method = "GET",
    body?: URLSearchParams,
  ): Promise<Response> => {
    if (!token) {
      throw new Error("MAL token missing. Run login mal or set MANIFOLD_MAL_TOKEN.");
    }
    if (!options.accessToken && session && session.expiresAt <= Date.now() + 60_000) {
      await refresh();
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      if (requested) {
        await sleep(1500);
      }
      requested = true;
      const response = await fetcher(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(body && { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(body && { body }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (response.status === 401 && !refreshed && !options.accessToken && session?.refreshToken) {
        await response.body?.cancel();
        await refresh();
        refreshed = true;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const wait =
          retryAfter === null
            ? NaN
            : Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(retryAfter) - Date.now();
        await response.body?.cancel();
        if (wait > 300_000) {
          throw new Error("MAL requested a long retry delay. Stop and resume later.");
        }
        await sleep(Number.isFinite(wait) ? Math.max(1500, wait) : 5000 * 2 ** attempt);
        continue;
      }
      if (!response.ok && !(method === "DELETE" && response.status === 404)) {
        await response.body?.cancel();
        throw new Error(
          `MAL ${method} ${path}: HTTP ${response.status}. Stopped; rerun to resume.`,
        );
      }
      return response;
    }
  };

  return {
    profile: async () =>
      Schema.decodeUnknownSync(Profile)(await (await request("/users/@me")).json()),
    manga: async (): Promise<MalManga[]> => {
      const entries = new Map<number, MalManga>();
      const visited = new Set<string>();
      let path: string | undefined = "/users/@me/mangalist?limit=1000&nsfw=true";
      while (path) {
        if (visited.has(path)) {
          throw new Error("MAL pagination repeated a page; refusing an incomplete scan.");
        }
        visited.add(path);
        const page = Schema.decodeUnknownSync(MangaPage)(await (await request(path)).json());
        for (const { node } of page.data) {
          if (node.id <= 0) {
            throw new Error("MAL returned an invalid manga ID.");
          }
          entries.set(node.id, node);
        }
        path = undefined;
        if (page.paging.next) {
          const next = new URL(page.paging.next);
          if (
            next.origin !== "https://api.myanimelist.net" ||
            next.pathname !== "/v2/users/@me/mangalist"
          ) {
            throw new Error("Unexpected MAL pagination URL; refusing to forward credentials.");
          }
          next.searchParams.set("nsfw", "true");
          path = next.pathname.slice(3) + next.search;
        }
      }
      return [...entries.values()];
    },
    deleteManga: async (id: number): Promise<void> => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("Invalid MAL manga ID.");
      }
      const response = await request(`/manga/${id}/my_list_status`, "DELETE");
      await response.body?.cancel();
    },
    updateManga: async (id: number, values: MalMangaUpdate): Promise<void> => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("Invalid MAL manga ID.");
      }
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) {
          body.set(key, String(value));
        }
      }
      if (body.size === 0) {
        throw new Error("MAL manga update needs at least one field.");
      }
      const response = await request(`/manga/${id}/my_list_status`, "PATCH", body);
      await response.body?.cancel();
    },
  };
};

export type MalClient = ReturnType<typeof createMalClient>;

/** Scan first, then delete. Rerunning scans only survivors, so no checkpoint file is needed. */
export const wipeMalManga = async (options: {
  readonly client: MalClient;
  readonly apply: boolean;
  readonly scanned: (account: string, entries: readonly MalManga[]) => void;
  readonly progress: (deleted: number, total: number) => void;
}) => {
  const profile = await options.client.profile();
  const entries = await options.client.manga();
  const summary = {
    account: profile.name,
    accountId: profile.id,
    scanned: entries.length,
    deleted: 0,
  };
  options.scanned(profile.name, entries);
  if (!options.apply || entries.length === 0) {
    return summary;
  }
  options.progress(0, entries.length);
  // A refresh must not silently switch the account between scan and deletion.
  if ((await options.client.profile()).id !== profile.id) {
    throw new Error("MAL account changed; refusing deletion.");
  }
  for (const entry of entries) {
    await options.client.deleteManga(entry.id);
    summary.deleted += 1;
    options.progress(summary.deleted, entries.length);
  }
  const remaining = await options.client.manga();
  if (remaining.length) {
    throw new Error(
      `MAL wipe incomplete: ${remaining.length} manga remain (${remaining.map((entry) => entry.id).join(", ")}). Check other writers and rerun.`,
    );
  }
  return summary;
};
