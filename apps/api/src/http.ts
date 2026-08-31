import { Effect } from "effect";
import {
  errorMessage,
  isJsonObject,
  isJsonValue,
  isString,
  type JsonValue,
} from "@manifold/json";
import type { MangaDexChapter, MangaDexPaged } from "@manifold/mangadex";
import type { CanonicalSearchResponse } from "./canonical";
import type {
  AuthConnection,
  AuthProvider,
  CanonicalEntry,
  ListEvent,
  ListState,
  MangaDexLibraryItem,
  OAuthProvider,
  ReadingProgress,
  SyncOp,
} from "./domain";
import type { MangaDexMatchResult } from "./mangadex-match";
import type { MangaDexEntryStat } from "./mangadex-stats";
import { readSecret } from "./read-secret";
import type { Env, RegistryListEntry } from "./types";

/** JSON-serializable HTTP bodies Response.json accepts from these routes. */
export type JsonResponseBody =
  | JsonValue
  | AuthConnection
  | CanonicalEntry
  | CanonicalSearchResponse
  | ListEvent
  | ListState
  | MangaDexLibraryItem
  | MangaDexMatchResult
  | MangaDexPaged<MangaDexChapter>
  | ReadingProgress
  | RegistryListEntry
  | SyncOp
  | readonly AuthConnection[]
  | readonly CanonicalEntry[]
  | readonly ListEvent[]
  | readonly MangaDexLibraryItem[]
  | readonly RegistryListEntry[]
  | readonly SyncOp[]
  | Record<string, MangaDexEntryStat>
  | { readonly chapters: readonly string[] }
  | { readonly connected: boolean; readonly provider: string }
  | { readonly details?: string; readonly error: string; readonly provider?: string }
  | { readonly enqueued: number }
  | { readonly entries: readonly CanonicalEntry[] | readonly RegistryListEntry[] }
  | { readonly entry: null }
  | { readonly events: readonly ListEvent[] }
  | { readonly id: string; readonly name?: string }
  | { readonly library: readonly MangaDexLibraryItem[] }
  | { readonly ok: true; readonly build?: string; readonly environment?: string; readonly state?: ListState }
  | { readonly ops: readonly SyncOp[] }
  | { readonly progress: ReadingProgress | null }
  | { readonly retried: number }
  | { readonly state: ListState | null }
  | { readonly stats: Record<string, MangaDexEntryStat> }
  | { readonly updated: number };

export interface RouteContext {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly path: readonly string[];
}

export type RouteEffect = Effect.Effect<Response | null, unknown>;

export const json = (body: JsonResponseBody, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export const parseJson = (request: Request): Effect.Effect<JsonValue, Error> =>
  Effect.tryPromise({
    try: async () => {
      const raw: unknown = await request.json();
      if (!isJsonValue(raw)) {
        throw new Error("Request body must be valid JSON");
      }
      return raw;
    },
    catch: () => new Error("Request body must be valid JSON"),
  });

export const toError = (cause: unknown): Error => {
  if (cause instanceof Error) {return cause;}
  if (isJsonObject(cause) && isString(cause.message)) {
    return new Error(cause.message);
  }
  return new Error(errorMessage(cause));
};

export const tryPromise = <A>(action: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: action,
    catch: toError,
  });

export const attempt = <A>(
  action: () => Promise<A>,
): Effect.Effect<{ ok: true; value: A } | { ok: false; error: Error }> =>
  Effect.promise(async () => {
    try {
      return { ok: true, value: await action() } as const;
    } catch (cause) {
      return { ok: false, error: toError(cause) } as const;
    }
  });

export const routeId = (value: string): string => decodeURIComponent(value);

export const authorized = async (request: Request, env: Env): Promise<boolean> => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {return false;}

  const expected = await readSecret(env.MANIFOLD_TOKEN, "MANIFOLD_TOKEN");
  const supplied = new TextEncoder().encode(authorization.slice("Bearer ".length));
  const suppliedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", supplied),
  );
  const expectedDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  );
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= suppliedDigest[index] ^ expectedDigest[index];
  }
  return difference === 0;
};

export const authProvider = (value: string | undefined): AuthProvider | undefined => {
  if (value === "anilist" || value === "mal" || value === "mangadex") {return value;}
  return undefined;
};

export const oauthProvider = (value: string | undefined): OAuthProvider | undefined => {
  if (value === "anilist" || value === "mal") {return value;}
  return undefined;
};

const oauthApiBaseUrl = (env: Pick<Env, "OAUTH_REDIRECT_BASE_URL">): string => {
  const base = env.OAUTH_REDIRECT_BASE_URL.replace(/\/+$/, "");
  // Older deployments stored the bare origin; the router mounts SyncApi under /api.
  // NOTE: new URL() would discard the base's path for an absolute path arg — concatenate.
  return base.endsWith("/api") ? base : `${base}/api`;
};

export const oauthRedirectUri = (
  provider: OAuthProvider,
  env: Pick<Env, "OAUTH_REDIRECT_BASE_URL">,
): string => `${oauthApiBaseUrl(env)}/v1/auth/${provider}/callback`;

export const anilistDeviceRedirectUri = (
  env: Pick<Env, "OAUTH_REDIRECT_BASE_URL">,
): string => `${oauthApiBaseUrl(env)}/v1/auth/anilist/device`;

export const isPublicOAuthRoute = (
  method: string,
  path: readonly string[],
): boolean => {
  if (
    method !== "GET" ||
    path.length !== 4 ||
    path[0] !== "v1" ||
    path[1] !== "auth"
  ) {
    return false;
  }
  return (
    (path[3] === "callback" && oauthProvider(path[2]) !== undefined) ||
    (path[2] === "anilist" && path[3] === "device")
  );
};
