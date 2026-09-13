import { Effect, Option, Schema } from "effect";
import { manifoldUserAgent } from "@manifold/json";
import {
  cliError,
  decodeJsonOption,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  newId,
  runHost,
  sleep,
  sleepPromise,
  type CliEffectError,
} from "@/effect-kit";

const API = "https://api.myanimelist.net/v2";
const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
export const MAL_REDIRECT_URI = "http://127.0.0.1:8766/callback";
const USER_AGENT = manifoldUserAgent("cli");

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.Finite,
});
export const MalSession = Schema.Struct({
  clientId: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.optional(Schema.NonEmptyString),
  expiresAt: Schema.Finite,
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
  const verifier = newId().replaceAll("-", "") + newId().replaceAll("-", "");
  const state = newId();
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

const requestMalTokensEffect = (
  clientId: string,
  clientSecret: string | undefined,
  grant: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Effect.Effect<MalSession, CliEffectError> =>
  Effect.gen(function* () {
    grant.set("client_id", clientId);
    if (clientSecret) {
      grant.set("client_secret", clientSecret);
    }
    // Do not retry token exchange: a lost response may have rotated the refresh token.
    const response = yield* fromPromise(() =>
      fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body: grant,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      }),
    ).pipe(Effect.mapError((cause) => cliError(`MAL token exchange failed: ${cause.message}`)));
    if (!response.ok) {
      return yield* cliError(
        `MAL token exchange failed: HTTP ${response.status}. Run login mal again.`,
      );
    }
    // Schema errors can include the received payload. Never expose token responses.
    const bodyResult = yield* jsonFromResponseEffect(response, "mal.tokens").pipe(
      Effect.map((body) => ({ ok: true as const, body })),
      Effect.orElseSucceed(() => ({ ok: false as const, body: undefined })),
    );
    const tokens = bodyResult.ok
      ? Option.getOrUndefined(decodeJsonOption(Tokens, bodyResult.body))
      : undefined;
    if (!tokens) {
      return yield* cliError("MAL returned an invalid token response. Run login mal again.");
    }
    return {
      clientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: epochMillisNow() + tokens.expires_in * 1000,
    };
  });

export const requestMalTokens = (
  clientId: string,
  clientSecret: string | undefined,
  grant: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Promise<MalSession> => runHost(requestMalTokensEffect(clientId, clientSecret, grant, fetcher));

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
  // Injected Promise sleep is for tests; default still uses Effect sleep via sleepPromise.
  const sleepFn = options.sleep ?? sleepPromise;
  let session = options.session;
  let token = options.accessToken ?? session?.accessToken;
  let requested = false;

  const refreshEffect = (): Effect.Effect<void, CliEffectError> =>
    Effect.gen(function* () {
      if (options.accessToken || !session?.refreshToken) {
        return yield* cliError("MAL token expired. Run login mal or replace MANIFOLD_MAL_TOKEN.");
      }
      const next = yield* requestMalTokensEffect(
        session.clientId,
        options.clientSecret,
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }),
        fetcher,
      );
      session = { ...next, refreshToken: next.refreshToken ?? session.refreshToken };
      token = session.accessToken;
      if (options.saveSession) {
        yield* fromPromise(() => options.saveSession!(session!)).pipe(
          Effect.mapError((cause) => cliError(`MAL session save failed: ${cause.message}`)),
        );
      }
    });

  const requestEffect = (
    path: string,
    method = "GET",
    body?: URLSearchParams,
  ): Effect.Effect<Response, CliEffectError> =>
    Effect.gen(function* () {
      if (!token) {
        return yield* cliError("MAL token missing. Run login mal or set MANIFOLD_MAL_TOKEN.");
      }
      if (!options.accessToken && session && session.expiresAt <= epochMillisNow() + 60_000) {
        yield* refreshEffect();
      }
      let refreshed = false;
      for (let attempt = 0; ; attempt += 1) {
        if (requested) {
          // Prefer injected sleep (tests) when provided; else Effect sleep.
          if (options.sleep) {
            yield* fromPromise(() => sleepFn(1500)).pipe(Effect.orDie);
          } else {
            yield* sleep(1500);
          }
        }
        requested = true;
        const response = yield* fromPromise(() =>
          fetcher(`${API}${path}`, {
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
          }),
        ).pipe(Effect.mapError((cause) => cliError(`MAL request failed: ${cause.message}`)));
        if (
          response.status === 401 &&
          !refreshed &&
          !options.accessToken &&
          session?.refreshToken
        ) {
          yield* fromPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.orDie);
          yield* refreshEffect();
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
                : Date.parse(retryAfter) - epochMillisNow();
          yield* fromPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.orDie);
          if (wait > 300_000) {
            return yield* cliError("MAL requested a long retry delay. Stop and resume later.");
          }
          const delayMs = Number.isFinite(wait) ? Math.max(1500, wait) : 5000 * 2 ** attempt;
          if (options.sleep) {
            yield* fromPromise(() => sleepFn(delayMs)).pipe(Effect.orDie);
          } else {
            yield* sleep(delayMs);
          }
          continue;
        }
        if (!response.ok && !(method === "DELETE" && response.status === 404)) {
          yield* fromPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.orDie);
          return yield* cliError(
            `MAL ${method} ${path}: HTTP ${response.status}. Stopped; rerun to resume.`,
          );
        }
        return response;
      }
    });

  const profileEffect = (): Effect.Effect<Schema.Schema.Type<typeof Profile>, CliEffectError> =>
    Effect.gen(function* () {
      const response = yield* requestEffect("/users/@me");
      const body = yield* jsonFromResponseEffect(response, "mal.profile");
      const profile = decodeJsonOption(Profile, body);
      if (Option.isNone(profile)) {
        return yield* cliError("mal.profile: schema rejected body");
      }
      return profile.value;
    });

  const mangaEffect = (): Effect.Effect<MalManga[], CliEffectError> =>
    Effect.gen(function* () {
      const entries = new Map<number, MalManga>();
      const visited = new Set<string>();
      let path: string | undefined = "/users/@me/mangalist?limit=1000&nsfw=true";
      while (path) {
        if (visited.has(path)) {
          return yield* cliError("MAL pagination repeated a page; refusing an incomplete scan.");
        }
        visited.add(path);
        const response = yield* requestEffect(path);
        const body = yield* jsonFromResponseEffect(response, "mal.manga");
        const page = decodeJsonOption(MangaPage, body);
        if (Option.isNone(page)) {
          return yield* cliError("mal.manga: schema rejected body");
        }
        for (const { node } of page.value.data) {
          if (node.id <= 0) {
            return yield* cliError("MAL returned an invalid manga ID.");
          }
          entries.set(node.id, node);
        }
        path = undefined;
        if (page.value.paging.next) {
          const next = new URL(page.value.paging.next);
          if (
            next.origin !== "https://api.myanimelist.net" ||
            next.pathname !== "/v2/users/@me/mangalist"
          ) {
            return yield* cliError(
              "Unexpected MAL pagination URL; refusing to forward credentials.",
            );
          }
          next.searchParams.set("nsfw", "true");
          path = next.pathname.slice(3) + next.search;
        }
      }
      return [...entries.values()];
    });

  const deleteMangaEffect = (id: number): Effect.Effect<void, CliEffectError> =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(id) || id <= 0) {
        return yield* cliError("Invalid MAL manga ID.");
      }
      const response = yield* requestEffect(`/manga/${id}/my_list_status`, "DELETE");
      yield* fromPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.orDie);
    });

  const updateMangaEffect = (
    id: number,
    values: MalMangaUpdate,
  ): Effect.Effect<void, CliEffectError> =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(id) || id <= 0) {
        return yield* cliError("Invalid MAL manga ID.");
      }
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) {
          body.set(key, String(value));
        }
      }
      if (body.size === 0) {
        return yield* cliError("MAL manga update needs at least one field.");
      }
      const response = yield* requestEffect(`/manga/${id}/my_list_status`, "PATCH", body);
      yield* fromPromise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.orDie);
    });

  return {
    profile: (): Promise<Schema.Schema.Type<typeof Profile>> => runHost(profileEffect()),
    manga: (): Promise<MalManga[]> => runHost(mangaEffect()),
    deleteManga: (id: number): Promise<void> => runHost(deleteMangaEffect(id)),
    updateManga: (id: number, values: MalMangaUpdate): Promise<void> =>
      runHost(updateMangaEffect(id, values)),
  };
};

export type MalClient = ReturnType<typeof createMalClient>;

/** Scan first, then delete. Rerunning scans only survivors, so no checkpoint file is needed. */
const wipeMalMangaEffect = (options: {
  readonly client: MalClient;
  readonly apply: boolean;
  readonly scanned: (account: string, entries: readonly MalManga[]) => void;
  readonly progress: (deleted: number, total: number) => void;
}): Effect.Effect<
  { account: string; accountId: number; scanned: number; deleted: number },
  CliEffectError
> =>
  Effect.gen(function* () {
    const profile = yield* fromPromise(() => options.client.profile());
    const entries = yield* fromPromise(() => options.client.manga());
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
    const verify = yield* fromPromise(() => options.client.profile());
    if (verify.id !== profile.id) {
      return yield* cliError("MAL account changed; refusing deletion.");
    }
    for (const entry of entries) {
      yield* fromPromise(() => options.client.deleteManga(entry.id));
      summary.deleted += 1;
      options.progress(summary.deleted, entries.length);
    }
    const remaining = yield* fromPromise(() => options.client.manga());
    if (remaining.length) {
      return yield* cliError(
        `MAL wipe incomplete: ${remaining.length} manga remain (${remaining.map((entry) => entry.id).join(", ")}). Check other writers and rerun.`,
      );
    }
    return summary;
  });

export const wipeMalManga = (options: {
  readonly client: MalClient;
  readonly apply: boolean;
  readonly scanned: (account: string, entries: readonly MalManga[]) => void;
  readonly progress: (deleted: number, total: number) => void;
}): Promise<{ account: string; accountId: number; scanned: number; deleted: number }> =>
  runHost(wipeMalMangaEffect(options));
