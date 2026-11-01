/** @effect-diagnostics asyncFunction:off */
/**
 * Shared MangaDex command plumbing: the password-grant credential flags, a
 * client that re-reads its token on demand, title lookup, and the write loop
 * that retries once after a 401. Async because the callers are listr task
 * callbacks.
 */
import { Effect, Option } from "effect";
import { Flag } from "effect/cli";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import {
  createMangaDexClient,
  MANGADEX_CONTENT_RATINGS,
  MangaDexSourceError,
  type MangaDexClient,
  type MangaDexPersonalClientCredentials,
} from "@manifold/mangadex";

import { cliError, envString, runHost, sleepPromise, type CliEffectError } from "@/effect-kit";
import { createMangaDexTokenManager } from "@/mangadex-token";
import { frameDetail, type PhaseReporter } from "@/ui";

const TOKEN_CACHE_PATH = ".tmp/mangadex-token.json";
const TITLE_BATCH_SIZE = 100;
const DETAIL_LINE_CAP = 40;

const credentialFlag = (name: string, variable: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(`Falls back to ${variable}.`));

/** Password-grant flags for MangaDex commands; spread into a `Command.make` config. */
export const mangadexCredentialFlags = {
  mangadexClientId: credentialFlag("mangadex-client-id", "MANIFOLD_MANGADEX_CLIENT_ID"),
  mangadexClientSecret: credentialFlag("mangadex-client-secret", "MANIFOLD_MANGADEX_CLIENT_SECRET"),
  mangadexUsername: credentialFlag("mangadex-username", "MANIFOLD_MANGADEX_USERNAME"),
  mangadexPassword: credentialFlag("mangadex-password", "MANIFOLD_MANGADEX_PASSWORD"),
};

export interface MangaDexCredentialFlags {
  readonly mangadexClientId: Option.Option<string>;
  readonly mangadexClientSecret: Option.Option<string>;
  readonly mangadexUsername: Option.Option<string>;
  readonly mangadexPassword: Option.Option<string>;
}

const flagOrEnv = (flag: Option.Option<string>, variable: string): string => {
  const direct = Option.getOrUndefined(flag);

  return direct !== undefined && direct !== "" ? direct : (envString(variable) ?? "");
};

/** Each credential from its flag, else its MANIFOLD_MANGADEX_* variable; "" when neither is set. */
export const resolveMangaDexCredentials = (
  flags: MangaDexCredentialFlags,
): MangaDexPersonalClientCredentials => ({
  clientId: flagOrEnv(flags.mangadexClientId, "MANIFOLD_MANGADEX_CLIENT_ID"),
  clientSecret: flagOrEnv(flags.mangadexClientSecret, "MANIFOLD_MANGADEX_CLIENT_SECRET"),
  username: flagOrEnv(flags.mangadexUsername, "MANIFOLD_MANGADEX_USERNAME"),
  password: flagOrEnv(flags.mangadexPassword, "MANIFOLD_MANGADEX_PASSWORD"),
});

export const missingMangaDexCredentials = (
  credentials: MangaDexPersonalClientCredentials,
): string[] => Object.entries(credentials).flatMap(([key, value]) => (value ? [] : [key]));

/** Resolved credentials, or a CLI error naming every missing one. */
export const requireMangaDexCredentials = Effect.fnUntraced(function* (
  flags: MangaDexCredentialFlags,
): Effect.fn.Return<MangaDexPersonalClientCredentials, CliEffectError> {
  const credentials = resolveMangaDexCredentials(flags);
  const missing = missingMangaDexCredentials(credentials);

  if (missing.length > 0) {
    return yield* cliError(
      `Missing MangaDex credentials: ${missing.join(", ")}. Pass them as flags or set MANIFOLD_MANGADEX_*.`,
    );
  }

  return credentials;
});

export interface MangaDexSession {
  /** Client for the current token; replaced by `refresh`. */
  readonly client: () => MangaDexClient;
  /** Re-read the token (minting or refreshing it as needed) and rebuild the client. */
  readonly refresh: () => Promise<void>;
}

/** Token manager plus client, with the token cached under .tmp between runs. */
export const openMangaDexSession = async (
  credentials: MangaDexPersonalClientCredentials,
): Promise<MangaDexSession> => {
  const manager = createMangaDexTokenManager({ credentials, cachePath: TOKEN_CACHE_PATH });

  const connect = async (): Promise<MangaDexClient> =>
    createMangaDexClient({
      accessToken: await manager.current(),
      userAgent: manifoldUserAgent("cli"),
    });

  let client = await connect();

  return {
    client: () => client,
    refresh: async () => {
      client = await connect();
    },
  };
};

/** Every followed manga id; `onPage` gets the running count and the reported total. */
export const fetchFollowedMangaIds = async (
  client: MangaDexClient,
  spacingMs: number,
  onPage: (followed: number, total: number) => void,
): Promise<Set<string>> => {
  const followed = new Set<string>();
  let offset = 0;

  while (true) {
    const page = await runHost(client.followedManga({ limit: 100, offset }));

    for (const manga of page.items) {
      followed.add(manga.id);
    }

    offset += page.items.length;
    const total = page.total ?? offset;
    onPage(followed.size, total);

    if (page.items.length === 0 || offset >= total) {
      return followed;
    }

    await sleepPromise(spacingMs);
  }
};

/** Titles for `ids`, fetched in pages of 100 with `spacingMs` between requests. */
export const fetchMangaDexTitles = async (
  client: MangaDexClient,
  ids: readonly string[],
  spacingMs: number,
): Promise<Record<string, string>> => {
  const titles: Record<string, string> = {};

  for (let start = 0; start < ids.length; start += TITLE_BATCH_SIZE) {
    const page = await runHost(
      client.listManga({
        ids: ids.slice(start, start + TITLE_BATCH_SIZE),
        contentRating: [...MANGADEX_CONTENT_RATINGS],
        limit: 100,
      }),
    );

    for (const manga of page.items) {
      titles[manga.id] = manga.title;
    }

    await sleepPromise(spacingMs);
  }

  return titles;
};

export interface MangaDexWriteBatch {
  readonly ids: readonly string[];
  readonly titles: Readonly<Record<string, string>>;
  readonly write: (
    client: MangaDexClient,
    mangaId: string,
  ) => Effect.Effect<void, MangaDexSourceError>;
  /** Past-tense verb for the summary (and per-entry lines), e.g. "updated". */
  readonly verb: string;
  readonly spacingMs: number;
  /** Print one line per successful write. */
  readonly listWritten: boolean;
}

/**
 * Apply `write` to every id in order. A 401 refreshes the token and retries
 * that entry once; other failures are collected, reported (capped) and set a
 * failing exit code, without stopping the batch.
 */
export const runMangaDexWrites = async (
  session: MangaDexSession,
  reporter: PhaseReporter,
  batch: MangaDexWriteBatch,
): Promise<void> => {
  const writeOnce = (mangaId: string) => runHost(batch.write(session.client(), mangaId));
  const failures: string[] = [];
  let done = 0;

  // A token from the start of the run may have expired during a long scan.
  await session.refresh();

  for (const mangaId of batch.ids) {
    const label = batch.titles[mangaId] ?? mangaId;

    try {
      await writeOnce(mangaId).catch(async (cause: unknown) => {
        if (!(cause instanceof MangaDexSourceError && cause.status === 401)) {
          throw cause;
        }

        await session.refresh();
        await writeOnce(mangaId);
      });

      if (batch.listWritten) {
        frameDetail(`  ${label} ${batch.verb}`);
      }
    } catch (cause) {
      failures.push(`${label}: ${errorMessage(cause)}`);
    }

    done += 1;
    reporter.progress(done, batch.ids.length, [["failed", failures.length]]);

    if (done < batch.ids.length) {
      await sleepPromise(batch.spacingMs);
    }
  }

  for (const failure of failures.slice(0, DETAIL_LINE_CAP)) {
    reporter.problem(failure);
  }

  if (failures.length > DETAIL_LINE_CAP) {
    reporter.problem(`…and ${failures.length - DETAIL_LINE_CAP} more failures`);
  }

  reporter.note(`${done - failures.length}/${done} ${batch.verb}.`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
};
