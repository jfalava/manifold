import {
  isFiniteNumber,
  isJsonObject,
  isString,
  type JsonObject,
} from "@manifold/json";
import type { Cookie, Request } from "@paperback/types";

/** Public admin SPA origin (CF Access gate sits in front). */
export const MANIFOLD_ADMIN_ORIGIN = "https://manifold.jfa.dev";

/** Default entry URL opened by the in-app admin browser sheet. */
export const MANIFOLD_ADMIN_URL = `${MANIFOLD_ADMIN_ORIGIN}/admin/`;

/** Secure-state blob of CF Access cookies (JSON array). */
export const ADMIN_ACCESS_PERSIST_KEY = "manifold.admin-access-v1";

/** Plain status label for settings forms (no secrets). */
export const ADMIN_ACCESS_STATUS_KEY = "manifold.admin-access-status-v1";

const ADMIN_HOST = "manifold.jfa.dev";

/** Cookie names CF Access sets on the protected host after login. */
const ACCESS_COOKIE_NAMES = new Set(["CF_Authorization", "CF_AppSession"]);

/** Fallback TTL when Access cookies arrive without expires (24h). */
const DEFAULT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

type PersistedAccessCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: string;
};

const isAccessCookieName = (name: string): boolean => ACCESS_COOKIE_NAMES.has(name);

/**
 * Accept cookies for manifold.jfa.dev and parent jfa.dev (Access sometimes
 * scopes the session cookie one level up). Empty domain is pinned later.
 */
export const domainMatchesAdmin = (domain: string): boolean => {
  const normalized = domain.trim().replace(/^\./, "").toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return (
    normalized === ADMIN_HOST ||
    normalized === "jfa.dev" ||
    normalized.endsWith(".jfa.dev")
  );
};

const pinAdminDomain = (domain: string | undefined): string => {
  if (!domain || domain.trim().length === 0) {
    return ADMIN_HOST;
  }
  const normalized = domain.trim().replace(/^\./, "").toLowerCase();
  if (normalized === "jfa.dev" || normalized.endsWith(".jfa.dev")) {
    // Prefer the concrete admin host so CookieStorage-style matchers attach.
    if (normalized === ADMIN_HOST || normalized.endsWith(`.${ADMIN_HOST}`)) {
      return normalized;
    }
    return ADMIN_HOST;
  }
  return ADMIN_HOST;
};

/** Decode one JWT payload segment without verifying the signature (status/TTL only). */
export const decodeJwtPayloadJson = (token: string): JsonObject | undefined => {
  const segment = token.split(".")[1];
  if (!segment) {
    return undefined;
  }
  const json = base64UrlToUtf8(segment);
  if (!json) {
    return undefined;
  }
  try {
    // SAFETY: boundary parse of untrusted JWT payload bytes for status/TTL only.
    const parsed: unknown = JSON.parse(json);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const base64UrlToUtf8 = (segment: string): string | undefined => {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");

    // Prefer Paperback's decoder when the host injects Application.
    try {
      const decoded = Application.base64Decode(padded);
      if (isString(decoded)) {
        return decoded;
      }
    } catch {
      // Unit tests and non-Paperback hosts fall through.
    }

    // Manual base64 → bytes → UTF-8 (no atob/Buffer dependency).
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const cleaned = padded.replace(/=+$/, "");
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const ch of cleaned) {
      const val = alphabet.indexOf(ch);
      if (val < 0) {
        return undefined;
      }
      buffer = (buffer << 6) | val;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    let out = "";
    for (let i = 0; i < bytes.length; ) {
      const c = bytes[i]!;
      if (c < 0x80) {
        out += String.fromCharCode(c);
        i += 1;
      } else if (c < 0xe0 && i + 1 < bytes.length) {
        out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
        i += 2;
      } else if (c < 0xf0 && i + 2 < bytes.length) {
        out += String.fromCharCode(
          ((c & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f),
        );
        i += 3;
      } else {
        // Skip invalid / 4-byte sequences for JWT JSON (ASCII-only claims).
        i += 1;
      }
    }
    return out;
  } catch {
    return undefined;
  }
};

const expMsFromAuthorization = (value: string): number | undefined => {
  const payload = decodeJwtPayloadJson(value);
  if (!payload) {
    return undefined;
  }
  const exp = payload["exp"];
  if (!isFiniteNumber(exp) || exp <= 0) {
    return undefined;
  }
  return exp * 1000;
};

const emailFromAuthorization = (value: string): string | undefined => {
  const payload = decodeJwtPayloadJson(value);
  if (!payload) {
    return undefined;
  }
  const email = payload["email"];
  return isString(email) && email.trim().length > 0 ? email.trim() : undefined;
};

/**
 * Keep only CF Access session cookies for the admin host. Pins empty domains
 * and synthesizes expires when the jar would otherwise drop session cookies
 * (same class of problem as Comix cf_clearance).
 */
export const filterAdminAccessCookies = (
  cookies: readonly Cookie[],
  nowMs: number = Date.now(),
): Cookie[] => {
  const byName = new Map<string, Cookie>();

  for (const cookie of cookies) {
    if (!isAccessCookieName(cookie.name) || cookie.value.trim().length === 0) {
      continue;
    }
    if (!domainMatchesAdmin(cookie.domain ?? "")) {
      continue;
    }

    let expires = cookie.expires instanceof Date ? cookie.expires : undefined;
    if (expires && Number.isNaN(expires.getTime())) {
      expires = undefined;
    }
    if (expires && expires.getTime() <= nowMs) {
      continue;
    }

    if (!expires) {
      const jwtExp =
        cookie.name === "CF_Authorization" ? expMsFromAuthorization(cookie.value) : undefined;
      const ttlEnd = jwtExp && jwtExp > nowMs ? jwtExp : nowMs + DEFAULT_ACCESS_TTL_MS;
      expires = new Date(ttlEnd);
    }

    byName.set(cookie.name, {
      name: cookie.name,
      value: cookie.value.trim(),
      domain: pinAdminDomain(cookie.domain),
      path: cookie.path && cookie.path.length > 0 ? cookie.path : "/",
      expires,
    });
  }

  // Authorization is the gate; AppSession alone is not enough to claim a session.
  if (!byName.has("CF_Authorization")) {
    return [];
  }

  return [...byName.values()];
};

export const adminAccessCookiesToRequestMap = (
  cookies: readonly Cookie[],
  nowMs: number = Date.now(),
): Record<string, string> =>
  Object.fromEntries(
    filterAdminAccessCookies(cookies, nowMs).map((cookie) => [cookie.name, cookie.value] as const),
  );

export const serializeAdminAccessCookies = (
  cookies: readonly Cookie[],
  nowMs: number = Date.now(),
): string => {
  const payload: PersistedAccessCookie[] = filterAdminAccessCookies(cookies, nowMs).map((cookie) => {
    const base: PersistedAccessCookie = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
    };
    if (cookie.expires instanceof Date && !Number.isNaN(cookie.expires.getTime())) {
      return { ...base, expires: cookie.expires.toISOString() };
    }
    return base;
  });
  return JSON.stringify(payload);
};

export const deserializeAdminAccessCookies = (
  raw: string,
  nowMs: number = Date.now(),
): Cookie[] => {
  try {
    // SAFETY: I/O JSON.parse of the persisted Access cookie blob.
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const restored: Cookie[] = [];
    for (const entry of parsed) {
      if (!isJsonObject(entry)) {
        continue;
      }
      if (!isString(entry["name"]) || !isString(entry["value"])) {
        continue;
      }
      let expires: Date | undefined;
      if (isString(entry["expires"])) {
        expires = new Date(entry["expires"]);
        if (Number.isNaN(expires.getTime())) {
          expires = undefined;
        }
      }
      const cookie: Cookie = {
        name: entry["name"],
        value: entry["value"],
        domain: isString(entry["domain"]) ? entry["domain"] : ADMIN_HOST,
        path: isString(entry["path"]) && entry["path"].length > 0 ? entry["path"] : "/",
      };
      restored.push(expires ? { ...cookie, expires } : cookie);
    }
    return filterAdminAccessCookies(restored, nowMs);
  } catch {
    return [];
  }
};

export const formatAdminAccessStatus = (
  cookies: readonly Cookie[],
  nowMs: number = Date.now(),
): string => {
  const live = filterAdminAccessCookies(cookies, nowMs);
  if (live.length === 0) {
    return "No session";
  }
  const auth = live.find((cookie) => cookie.name === "CF_Authorization");
  const email = auth ? emailFromAuthorization(auth.value) : undefined;
  const exp = auth?.expires instanceof Date ? auth.expires : undefined;
  const expLabel =
    exp && !Number.isNaN(exp.getTime())
      ? ` · exp ${exp.toISOString().slice(0, 16).replace("T", " ")}Z`
      : "";
  if (email) {
    return `${email}${expLabel}`;
  }
  return `Session · ${live.length} cookie(s)${expLabel}`;
};

/** Read stored Access cookies (empty when missing/expired). */
export const restoreAdminAccessCookies = (nowMs: number = Date.now()): Cookie[] => {
  const raw = Application.getSecureState(ADMIN_ACCESS_PERSIST_KEY);
  if (!isString(raw) || raw.trim().length === 0) {
    return [];
  }
  return deserializeAdminAccessCookies(raw, nowMs);
};

/**
 * Persist harvested Access cookies. Empty harvest is a no-op so a cancelled
 * or partial WebView close cannot wipe a still-valid session.
 */
export const persistAdminAccessCookies = (cookies: readonly Cookie[]): Cookie[] => {
  const live = filterAdminAccessCookies(cookies);
  if (live.length === 0) {
    return restoreAdminAccessCookies();
  }
  Application.setSecureState(serializeAdminAccessCookies(live), ADMIN_ACCESS_PERSIST_KEY);
  Application.setState(formatAdminAccessStatus(live), ADMIN_ACCESS_STATUS_KEY);
  return live;
};

export const clearAdminAccessCookies = (): void => {
  // Never pass null to setSecureState (keychain gotcha); empty string clears.
  Application.setSecureState("", ADMIN_ACCESS_PERSIST_KEY);
  Application.setState("No session", ADMIN_ACCESS_STATUS_KEY);
};

export const readAdminAccessStatus = (): string => {
  const live = restoreAdminAccessCookies();
  if (live.length > 0) {
    const label = formatAdminAccessStatus(live);
    Application.setState(label, ADMIN_ACCESS_STATUS_KEY);
    return label;
  }
  const stored = Application.getState(ADMIN_ACCESS_STATUS_KEY);
  if (isString(stored) && stored.trim().length > 0) {
    return stored.trim();
  }
  return "No session";
};

/** Build a WebViewRow request that re-seeds the Access jar when present. */
export const buildAdminWebViewRequest = (path: string = "/admin/"): Request => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const cookies = adminAccessCookiesToRequestMap(restoreAdminAccessCookies());
  const request: Request = {
    url: `${MANIFOLD_ADMIN_ORIGIN}${normalizedPath}`,
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  };
  if (Object.keys(cookies).length > 0) {
    return { ...request, cookies };
  }
  return request;
};
