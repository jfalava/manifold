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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export const parseCookieHeader = (header: string): ComixCookie[] => {
  const cookies: ComixCookie[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {continue;}
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {continue;}
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name.length === 0 || value.length === 0) {continue;}
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

export const parseComixCookie = (value: unknown): ComixCookie | undefined => {
  if (!isRecord(value)) {return undefined;}
  const name = asString(value.name);
  const cookieValue = asString(value.value);
  if (!name || !cookieValue) {return undefined;}
  return {
    name,
    value: cookieValue,
    ...(asString(value.domain) && { domain: asString(value.domain) }),
    ...(asString(value.path) && { path: asString(value.path) }),
    ...(asNumber(value.expires) !== undefined && { expires: asNumber(value.expires) }),
    ...(asBoolean(value.httpOnly) !== undefined && { httpOnly: asBoolean(value.httpOnly) }),
    ...(asBoolean(value.secure) !== undefined && { secure: asBoolean(value.secure) }),
    ...(asString(value.sameSite) && { sameSite: asString(value.sameSite) }),
    ...(asBoolean(value.session) !== undefined && { session: asBoolean(value.session) }),
  };
};

export const parseStoredSession = (raw: string): StoredComixSession | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.cookies)) {
      return undefined;
    }
    const cookies = parsed.cookies.map(parseComixCookie).filter(
      (cookie): cookie is ComixCookie => cookie !== undefined,
    );
    if (cookies.length === 0) {return undefined;}
    const harvestedAt = asNumber(parsed.harvestedAt);
    if (harvestedAt === undefined) {return undefined;}
    return {
      version: 1,
      cookies,
      harvestedAt,
      ...(asString(parsed.userAgent) && { userAgent: asString(parsed.userAgent) }),
    };
  } catch {
    return undefined;
  }
};

export const clearanceExpiresAtMs = (cookies: readonly ComixCookie[]): number | undefined => {
  // SAFETY: value is number) at this site
  const expiries = cookies
    .filter((cookie) => cookie.name === "cf_clearance" && typeof cookie.expires === "number" && cookie.expires > 0)
    // SAFETY: value is a number after the preceding runtime check
    .map((cookie) => cookie.expires as number)
    .map((expires) => (expires < 1_000_000_000_000 ? expires * 1000 : expires));
  if (expiries.length === 0) {return undefined;}
  return Math.min(...expiries);
};

export const isSessionFresh = (session: StoredComixSession, now = Date.now()): boolean => {
  const clearance = session.cookies.filter(
    (cookie) => cookie.name === "cf_clearance" && cookie.value.length > 0,
  );
  if (clearance.length === 0) {return false;}
  const expiresAt = clearanceExpiresAtMs(session.cookies);
  if (expiresAt === undefined) {return true;}
  return expiresAt > now + SESSION_SKEW_MS;
};

export const loadStoredSession = async (
  store: SecretStore,
  now = Date.now(),
): Promise<StoredComixSession | undefined> => {
  const raw = await store.get(SECRETS_SERVICE, SECRETS_NAME);
  if (!raw) {return undefined;}
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

export const cookiesFromCdp = (value: unknown): ComixCookie[] => {
  const list = isRecord(value) && Array.isArray(value.cookies)
    ? value.cookies
    : Array.isArray(value)
      ? value
      : [];
  return list.map(parseComixCookie).filter((cookie): cookie is ComixCookie => cookie !== undefined);
};

export interface CdpCookieParam {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
}

export const toCdpCookie = (cookie: ComixCookie): CdpCookieParam => {
  const expires = cookie.expires;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "comix.to",
    path: cookie.path ?? "/",
    ...(expires !== undefined && expires > 0 && { expires: expires > 1_000_000_000_000 ? expires / 1000 : expires }),
    ...(cookie.httpOnly !== undefined && { httpOnly: cookie.httpOnly }),
    secure: cookie.secure ?? true,
    ...(cookie.sameSite && { sameSite: cookie.sameSite }),
  };
};
