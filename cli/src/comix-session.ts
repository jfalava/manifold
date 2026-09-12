/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import {
  arrayField,
  isBoolean,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  numberField,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";

export const SECRETS_SERVICE = "manifold";
export const SECRETS_NAME = "comix-session";
export const SESSION_SKEW_MS = 60_000;

export interface ComixCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
  readonly session?: boolean;
}

export interface StoredComixSession {
  readonly version: 1;
  readonly cookies: readonly ComixCookie[];
  readonly userAgent?: string;
  readonly harvestedAt: number;
}

export interface SecretStore {
  readonly get: (service: string, name: string) => Promise<string | null>;
  readonly set: (service: string, name: string, value: string) => Promise<void>;
  readonly delete: (service: string, name: string) => Promise<boolean>;
}

export const bunSecretStore: SecretStore = {
  get: (service, name) => Bun.secrets.get({ service, name }),
  set: (service, name, value) => Bun.secrets.set({ service, name, value }),
  delete: (service, name) => Bun.secrets.delete({ service, name }),
};

const presentString = (value: JsonValue | undefined): string | undefined =>
  isString(value) && value.length > 0 ? value : undefined;

const cookiesFromJsonList = (list: readonly JsonValue[]): ComixCookie[] =>
  list.flatMap((item) => {
    if (!isJsonObject(item)) {
      return [];
    }
    const cookie = parseComixCookie(item);
    return cookie === undefined ? [] : [cookie];
  });

export const parseCookieHeader = (header: string): ComixCookie[] => {
  const cookies: ComixCookie[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name.length === 0 || value.length === 0) {
      continue;
    }
    cookies.push({
      name,
      value,
      domain: "comix.to",
      path: "/",
      secure: true,
    });
  }
  return cookies;
};

export const cookiesFromFlags = (options: {
  readonly cfClearance?: string;
  readonly session?: string;
  readonly cookieHeader?: string;
}): ComixCookie[] => {
  if (options.cookieHeader && options.cookieHeader.trim().length > 0) {
    return parseCookieHeader(options.cookieHeader);
  }
  const cookies: ComixCookie[] = [];
  if (options.cfClearance) {
    cookies.push({
      name: "cf_clearance",
      value: options.cfClearance,
      domain: "comix.to",
      path: "/",
      secure: true,
    });
  }
  if (options.session) {
    cookies.push({
      name: "session",
      value: options.session,
      domain: "comix.to",
      path: "/",
      secure: true,
    });
  }
  return cookies;
};

export const parseComixCookie = (value: JsonObject): ComixCookie | undefined => {
  const name = presentString(value.name);
  const cookieValue = presentString(value.value);
  if (name === undefined || cookieValue === undefined) {
    return undefined;
  }
  const domain = presentString(value.domain);
  const path = presentString(value.path);
  const expires = isFiniteNumber(value.expires) ? value.expires : undefined;
  const httpOnly = isBoolean(value.httpOnly) ? value.httpOnly : undefined;
  const secure = isBoolean(value.secure) ? value.secure : undefined;
  const sameSite = presentString(value.sameSite);
  const session = isBoolean(value.session) ? value.session : undefined;
  return {
    name,
    value: cookieValue,
    ...(domain !== undefined && { domain }),
    ...(path !== undefined && { path }),
    ...(expires !== undefined && { expires }),
    ...(httpOnly !== undefined && { httpOnly }),
    ...(secure !== undefined && { secure }),
    ...(sameSite !== undefined && { sameSite }),
    ...(session !== undefined && { session }),
  };
};

export const parseStoredSession = (raw: string): StoredComixSession | undefined => {
  try {
    // SAFETY: secret-store JSON is decoded via isJsonObject / parseComixCookie below
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed) || parsed.version !== 1) {
      return undefined;
    }
    const cookiesRaw = arrayField(parsed, "cookies");
    if (cookiesRaw === undefined) {
      return undefined;
    }
    const cookies = cookiesFromJsonList(cookiesRaw);
    if (cookies.length === 0) {
      return undefined;
    }
    const harvestedAt = numberField(parsed, "harvestedAt");
    if (harvestedAt === undefined) {
      return undefined;
    }
    const userAgent = presentString(parsed.userAgent);
    return {
      version: 1,
      cookies,
      harvestedAt,
      ...(userAgent !== undefined && { userAgent }),
    };
  } catch {
    return undefined;
  }
};

export const clearanceExpiresAtMs = (cookies: readonly ComixCookie[]): number | undefined => {
  const expiries = cookies.flatMap((cookie) => {
    if (cookie.name !== "cf_clearance") {
      return [];
    }
    const expires = cookie.expires;
    if (expires === undefined || expires <= 0) {
      return [];
    }
    return [expires < 1_000_000_000_000 ? expires * 1000 : expires];
  });
  if (expiries.length === 0) {
    return undefined;
  }
  return Math.min(...expiries);
};

export const isSessionFresh = (session: StoredComixSession, now = Date.now()): boolean => {
  const clearance = session.cookies.filter(
    (cookie) => cookie.name === "cf_clearance" && cookie.value.length > 0,
  );
  if (clearance.length === 0) {
    return false;
  }
  const expiresAt = clearanceExpiresAtMs(session.cookies);
  if (expiresAt === undefined) {
    return true;
  }
  return expiresAt > now + SESSION_SKEW_MS;
};

export const loadStoredSession = async (
  store: SecretStore,
  now = Date.now(),
): Promise<StoredComixSession | undefined> => {
  const raw = await store.get(SECRETS_SERVICE, SECRETS_NAME);
  if (!raw) {
    return undefined;
  }
  const parsed = parseStoredSession(raw);
  if (!parsed || !isSessionFresh(parsed, now)) {
    await store.delete(SECRETS_SERVICE, SECRETS_NAME);
    return undefined;
  }
  return parsed;
};

export const saveStoredSession = async (
  store: SecretStore,
  session: StoredComixSession,
): Promise<void> => {
  await store.set(SECRETS_SERVICE, SECRETS_NAME, JSON.stringify(session));
};

export const clearStoredSession = async (store: SecretStore): Promise<void> => {
  await store.delete(SECRETS_SERVICE, SECRETS_NAME);
};

export const sessionFromCookies = (
  cookies: readonly ComixCookie[],
  userAgent: string | undefined,
  harvestedAt = Date.now(),
): StoredComixSession => ({
  version: 1,
  cookies: [...cookies],
  harvestedAt,
  ...(userAgent && { userAgent }),
});

export const cookiesFromCdp = (value: JsonValue): ComixCookie[] => {
  const list =
    isJsonObject(value) && isJsonArray(value.cookies)
      ? value.cookies
      : isJsonArray(value)
        ? value
        : [];
  return cookiesFromJsonList(list);
};

export const toCdpCookie = (cookie: ComixCookie): JsonObject => {
  const expires = cookie.expires;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "comix.to",
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    ...(expires !== undefined &&
      expires > 0 && {
        expires: expires > 1_000_000_000_000 ? expires / 1000 : expires,
      }),
    ...(cookie.httpOnly !== undefined && { httpOnly: cookie.httpOnly }),
    ...(cookie.sameSite !== undefined &&
      cookie.sameSite.length > 0 && { sameSite: cookie.sameSite }),
  };
};
