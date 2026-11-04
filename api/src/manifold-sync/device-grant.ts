/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for the Manifold CLI.
 *
 * The CLI asks for a device code, shows the user code, and polls the token
 * endpoint. The user opens /device in any browser, checks the code, and
 * approves by signing in with the allowlisted GitHub account. No loopback
 * server or pasted callback is involved, so headless hosts sign in the same
 * way as desktops.
 */
import { Effect } from "effect";

import { publicSiteOrigin, resolveRedirectBase } from "../http";
import { createPkceChallenge, createRandomValue } from "../oauth";
import type { ManifoldDeviceGrantRow } from "../sync-rows";
import { now } from "./constants";
import { fromPromise } from "./from-promise";
import type { SqlHost } from "./host";
import {
  createSessionEffect,
  githubAuthorizationUrlEffect,
  githubSubjectEffect,
  hashOpaque,
  MANIFOLD_CLI_OAUTH_CLIENT_ID,
  type ManifoldOAuthTokenResponse,
} from "./manifold-oauth";

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_GRANT_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** RFC 8628 §6.1: consonants only, so codes never spell words and are easy to read aloud. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** GitHub upstream states for device approvals carry this prefix so the shared callback can route them. */
const DEVICE_GITHUB_STATE_PREFIX = "device.";

// A request delayed in transit can land slightly inside the interval after an earlier one.
const POLL_TOLERANCE_MS = 1000;

export const isDeviceGithubState = (state: string): boolean =>
  state.startsWith(DEVICE_GITHUB_STATE_PREFIX);

const createUserCode = (): string => {
  let code = "";

  while (code.length < USER_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH));

    for (const byte of bytes) {
      // Rejection sampling: 240 is the largest multiple of 20 below 256, so every letter is equally likely.
      if (byte < 240 && code.length < USER_CODE_LENGTH) {
        code += USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length);
      }
    }
  }

  return code;
};

/** Accepts the code as typed: any case, with or without the dash or spaces. */
const USER_CODE_RE = new RegExp(`^[${USER_CODE_ALPHABET}]{${USER_CODE_LENGTH}}$`);

export const normalizeUserCode = (input: string): string | undefined => {
  const code = input.toUpperCase().replaceAll(/[^A-Z]/g, "");

  return USER_CODE_RE.test(code) ? code : undefined;
};

export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

const startDeviceAuthorizationEffect = (host: SqlHost, clientId: string) =>
  Effect.gen(function* () {
    if (clientId !== MANIFOLD_CLI_OAUTH_CLIENT_ID) {
      return undefined;
    }

    const createdAt = now();
    host.ctx.storage.sql.exec("DELETE FROM manifold_device_grants WHERE expires_at < ?", createdAt);

    const deviceCode = `mf_device_${createRandomValue(32)}`;
    const deviceCodeHash = yield* fromPromise(() => hashOpaque(deviceCode));
    let userCode = createUserCode();

    // 20^8 codes against a handful of live grants: a collision is vanishingly rare, but never reuse one.
    while (
      host.ctx.storage.sql
        .exec("SELECT 1 FROM manifold_device_grants WHERE user_code = ?", userCode)
        .toArray().length > 0
    ) {
      userCode = createUserCode();
    }

    host.ctx.storage.sql.exec(
      `INSERT INTO manifold_device_grants
       (device_code_hash, user_code, client_id, status, interval_seconds, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      deviceCodeHash,
      userCode,
      clientId,
      DEVICE_POLL_INTERVAL_SECONDS,
      createdAt,
      createdAt + DEVICE_GRANT_TTL_SECONDS * 1000,
    );

    const origin = publicSiteOrigin(yield* fromPromise(() => resolveRedirectBase(host.env)));
    const verificationUri = `${origin}/device`;

    return {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${formatUserCode(userCode)}`,
      expires_in: DEVICE_GRANT_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    } satisfies DeviceAuthorizationResponse;
  });

/** Returns undefined for an unknown client. */
export const startDeviceAuthorization = (
  host: SqlHost,
  clientId: string,
): Promise<DeviceAuthorizationResponse | undefined> =>
  Effect.runPromise(startDeviceAuthorizationEffect(host, clientId));

/** What the approval page shows; expired and unknown codes look the same. */
export type DeviceGrantStatus = "pending" | "approved" | "denied" | "unknown";

const liveGrant = (host: SqlHost, userCodeInput: string): ManifoldDeviceGrantRow | undefined => {
  const userCode = normalizeUserCode(userCodeInput);

  if (!userCode) {
    return undefined;
  }

  return host.ctx.storage.sql
    .exec<ManifoldDeviceGrantRow>(
      "SELECT * FROM manifold_device_grants WHERE user_code = ? AND expires_at >= ?",
      userCode,
      now(),
    )
    .toArray()[0];
};

const grantStatus = (row: ManifoldDeviceGrantRow | undefined): DeviceGrantStatus => {
  if (!row) {
    return "unknown";
  }

  return row.status === "approved" || row.status === "denied" ? row.status : "pending";
};

export const lookupDeviceGrant = (host: SqlHost, userCode: string): Promise<DeviceGrantStatus> =>
  Effect.runPromise(Effect.sync(() => grantStatus(liveGrant(host, userCode))));

export const denyDeviceGrant = (host: SqlHost, userCode: string): Promise<DeviceGrantStatus> =>
  Effect.runPromise(
    Effect.sync(() => {
      const row = liveGrant(host, userCode);

      if (row?.status !== "pending") {
        return grantStatus(row);
      }

      host.ctx.storage.sql.exec(
        `UPDATE manifold_device_grants
         SET status = 'denied', provider_state = NULL, provider_code_verifier = NULL,
             browser_binding_hash = NULL
         WHERE device_code_hash = ?`,
        row.device_code_hash,
      );

      return "denied" as const;
    }),
  );

export type DeviceApprovalStart =
  | {
      readonly kind: "redirect";
      readonly authorizationUrl: string;
      /** Set as a cookie; the GitHub callback must come back to the same browser. */
      readonly browserBinding: string;
    }
  | { readonly kind: "status"; readonly status: Exclude<DeviceGrantStatus, "pending"> };

const beginDeviceApprovalEffect = (host: SqlHost, userCode: string) =>
  Effect.gen(function* () {
    const row = liveGrant(host, userCode);
    const status = grantStatus(row);

    if (!row || status !== "pending") {
      return {
        kind: "status",
        status: status === "pending" ? "unknown" : status,
      } as const satisfies DeviceApprovalStart;
    }

    const providerState = `${DEVICE_GITHUB_STATE_PREFIX}${createRandomValue()}`;
    const providerCodeVerifier = createRandomValue(48);
    const browserBinding = createRandomValue();

    const providerCodeChallenge = yield* fromPromise(() =>
      createPkceChallenge(providerCodeVerifier),
    );

    const browserBindingHash = yield* fromPromise(() => hashOpaque(browserBinding));

    const authorizationUrl = yield* githubAuthorizationUrlEffect(
      host,
      providerState,
      providerCodeChallenge,
    );

    // A newer approval attempt replaces an abandoned one for the same code.
    host.ctx.storage.sql.exec(
      `UPDATE manifold_device_grants
       SET provider_state = ?, provider_code_verifier = ?, browser_binding_hash = ?
       WHERE device_code_hash = ?`,
      providerState,
      providerCodeVerifier,
      browserBindingHash,
      row.device_code_hash,
    );

    return {
      kind: "redirect",
      authorizationUrl,
      browserBinding,
    } as const satisfies DeviceApprovalStart;
  });

export const beginDeviceApproval = (
  host: SqlHost,
  userCode: string,
): Promise<DeviceApprovalStart> => Effect.runPromise(beginDeviceApprovalEffect(host, userCode));

/**
 * Outcome of the GitHub round trip for a device approval:
 * - `approved`: the CLI receives tokens on its next poll.
 * - `denied`: GitHub authorization was cancelled; the CLI stops.
 * - `mismatch`: not the allowlisted account; the grant stays pending for another try.
 * - `wrong-browser`: the callback arrived without the binding cookie; stays pending.
 * - `expired`: unknown, expired, or already-finished approval attempt.
 * - `error`: GitHub failed; stays pending.
 */
export type DeviceApprovalResult =
  | "approved"
  | "denied"
  | "mismatch"
  | "wrong-browser"
  | "expired"
  | "error";

const completeDeviceGithubEffect = (
  host: SqlHost,
  providerState: string,
  browserBinding: string | undefined,
  code: string | undefined,
  error: string | undefined,
) =>
  Effect.gen(function* () {
    const row = host.ctx.storage.sql
      .exec<ManifoldDeviceGrantRow>(
        `SELECT * FROM manifold_device_grants
         WHERE provider_state = ? AND status = 'pending' AND expires_at >= ?`,
        providerState,
        now(),
      )
      .toArray()[0];

    if (!row?.provider_code_verifier || !row.browser_binding_hash) {
      return "expired" satisfies DeviceApprovalResult;
    }

    // Without this check, a GitHub link started in an attacker's browser and sent
    // to the owner would approve the attacker's device code on a silent re-auth.
    const suppliedBindingHash = browserBinding
      ? yield* fromPromise(() => hashOpaque(browserBinding))
      : undefined;

    if (suppliedBindingHash !== row.browser_binding_hash) {
      return "wrong-browser" satisfies DeviceApprovalResult;
    }

    const verifier = row.provider_code_verifier;

    // Consume the upstream state before external I/O so a callback cannot be replayed.
    host.ctx.storage.sql.exec(
      `UPDATE manifold_device_grants
       SET provider_state = NULL, provider_code_verifier = NULL, browser_binding_hash = NULL
       WHERE device_code_hash = ?`,
      row.device_code_hash,
    );

    if (error || !code) {
      host.ctx.storage.sql.exec(
        "UPDATE manifold_device_grants SET status = 'denied' WHERE device_code_hash = ?",
        row.device_code_hash,
      );

      return "denied" satisfies DeviceApprovalResult;
    }

    const github = yield* githubSubjectEffect(host, code, verifier);

    if (github.kind !== "ok") {
      return github.kind satisfies DeviceApprovalResult;
    }

    host.ctx.storage.sql.exec(
      `UPDATE manifold_device_grants SET status = 'approved', subject = ?
       WHERE device_code_hash = ? AND status = 'pending'`,
      github.subject,
      row.device_code_hash,
    );

    return "approved" satisfies DeviceApprovalResult;
  });

export const completeDeviceGithub = (
  host: SqlHost,
  providerState: string,
  browserBinding: string | undefined,
  code?: string,
  error?: string,
): Promise<DeviceApprovalResult> =>
  Effect.runPromise(completeDeviceGithubEffect(host, providerState, browserBinding, code, error));

/** RFC 8628 §3.5 token-endpoint errors, plus RFC 6749 errors for bad requests. */
export type DevicePollError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "invalid_client";

export type DevicePollResult =
  | { readonly kind: "token"; readonly token: ManifoldOAuthTokenResponse }
  | { readonly kind: "error"; readonly error: DevicePollError };

const pollError = (error: DevicePollError): DevicePollResult => ({ kind: "error", error });

const pollDeviceTokenEffect = (host: SqlHost, clientId: string, deviceCode: string) =>
  Effect.gen(function* () {
    if (clientId !== MANIFOLD_CLI_OAUTH_CLIENT_ID) {
      return pollError("invalid_client");
    }

    const deviceCodeHash = yield* fromPromise(() => hashOpaque(deviceCode));

    const row = host.ctx.storage.sql
      .exec<ManifoldDeviceGrantRow>(
        "SELECT * FROM manifold_device_grants WHERE device_code_hash = ? AND client_id = ?",
        deviceCodeHash,
        clientId,
      )
      .toArray()[0];

    if (!row) {
      return pollError("invalid_grant");
    }

    const polledAt = now();

    if (row.expires_at < polledAt) {
      host.ctx.storage.sql.exec(
        "DELETE FROM manifold_device_grants WHERE device_code_hash = ?",
        deviceCodeHash,
      );

      return pollError("expired_token");
    }

    if (row.status === "denied") {
      host.ctx.storage.sql.exec(
        "DELETE FROM manifold_device_grants WHERE device_code_hash = ?",
        deviceCodeHash,
      );

      return pollError("access_denied");
    }

    if (row.status === "approved") {
      // DELETE ... RETURNING is the consume step: concurrent polls cannot both receive tokens.
      const consumed = host.ctx.storage.sql
        .exec<ManifoldDeviceGrantRow>(
          `DELETE FROM manifold_device_grants
           WHERE device_code_hash = ? AND status = 'approved'
           RETURNING *`,
          deviceCodeHash,
        )
        .toArray()[0];

      if (!consumed?.subject) {
        return pollError("invalid_grant");
      }

      return {
        kind: "token",
        token: yield* createSessionEffect(host, consumed.subject),
      } satisfies DevicePollResult;
    }

    const tooSoon =
      row.last_polled_at !== null &&
      polledAt - row.last_polled_at < row.interval_seconds * 1000 - POLL_TOLERANCE_MS;

    host.ctx.storage.sql.exec(
      `UPDATE manifold_device_grants
       SET last_polled_at = ?, interval_seconds = interval_seconds + ?
       WHERE device_code_hash = ?`,
      polledAt,
      tooSoon ? 5 : 0,
      deviceCodeHash,
    );

    return pollError(tooSoon ? "slow_down" : "authorization_pending");
  });

export const pollDeviceToken = (
  host: SqlHost,
  clientId: string,
  deviceCode: string,
): Promise<DevicePollResult> =>
  Effect.runPromise(pollDeviceTokenEffect(host, clientId, deviceCode));
