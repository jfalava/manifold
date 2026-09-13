import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect, Option, Schema } from "effect";

import { runHost } from "./effect-host";

const CF_ACCESS_AUD = "e3e4ba96742b923bd136fb6b3f054867c6ca047d47af07b614f5357173d6f761";

export interface AccessIdentity {
  email: string | null;
  subject: string;
}

const AccessJwtPayloadSchema = Schema.Struct({
  aud: Schema.optional(Schema.String),
  sub: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const JwtJsonString = Schema.fromJsonString(Schema.Unknown);

type AccessJwtPayload = Schema.Schema.Type<typeof AccessJwtPayloadSchema>;

function decodeJwtPayload(token: string): AccessJwtPayload | null {
  const segment = token.split(".")[1];
  if (!segment) {
    return null;
  }
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    const parsed = Schema.decodeOption(JwtJsonString)(json);
    if (Option.isNone(parsed)) {
      return null;
    }
    const decoded = Schema.decodeUnknownOption(AccessJwtPayloadSchema)(parsed.value);
    return Option.isSome(decoded) ? decoded.value : null;
  } catch {
    return null;
  }
}

const getAccessIdentityProgram = Effect.fnUntraced(
  function* (): Effect.fn.Return<AccessIdentity | null> {
    const token = yield* Effect.sync(() => getRequest().headers.get("cf-access-jwt-assertion"));
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

export const getAccessIdentity = createServerFn({ method: "GET" }).handler(() =>
  runHost(getAccessIdentityProgram()),
);
