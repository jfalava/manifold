import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

const CF_ACCESS_AUD = "e3e4ba96742b923bd136fb6b3f054867c6ca047d47af07b614f5357173d6f761";

export interface AccessIdentity {
  email: string | null;
  subject: string;
}

interface AccessJwtPayload {
  aud?: string;
  sub?: string;
  email?: string;
}

interface JwtPayloadFields {
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly email?: unknown;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: boundary parser for JWT JSON; validates untrusted token payload at I/O edge
function isJwtPayloadObject(value: unknown): value is JwtPayloadFields {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: boundary object guard; centralizes typeof for JWT parsing
  return typeof value === "object" && value !== null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: helper for string narrowing at boundary; used only by JWT parser
function isStringValue(value: unknown): value is string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: central string guard for JWT fields
  return typeof value === "string";
}

function decodeJwtPayload(token: string): AccessJwtPayload | null {
  const segment = token.split(".")[1];
  if (!segment) {
    return null;
  }
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    const parsed: unknown = JSON.parse(json);
    if (!isJwtPayloadObject(parsed)) {
      return null;
    }
    return {
      aud: isStringValue(parsed.aud) ? parsed.aud : undefined,
      sub: isStringValue(parsed.sub) ? parsed.sub : undefined,
      email: isStringValue(parsed.email) ? parsed.email : undefined,
    };
  } catch {
    return null;
  }
}

export const getAccessIdentity = createServerFn({ method: "GET" }).handler(
  (): AccessIdentity | null => {
    const token = getRequest().headers.get("cf-access-jwt-assertion");
    if (!token) {
      return null;
    }
    const payload = decodeJwtPayload(token);
    if (!payload || payload.aud !== CF_ACCESS_AUD || !payload.sub) {
      return null;
    }
    return {
      email: payload.email ?? null,
      subject: payload.sub,
    };
  },
);
