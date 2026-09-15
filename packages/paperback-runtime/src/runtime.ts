/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import {
  isJsonObject,
  isJsonValue,
  isString,
  numberField,
  stringField,
  type JsonValue,
} from "@manifold/json";
import { Effect, Schema } from "effect";
import { fromPromise } from "./from-promise.js";
import {
  createPersonalApiClient,
  MANIFOLD_API_ACCESS_EXPIRES_AT_KEY,
  MANIFOLD_API_ACCESS_TOKEN_KEY,
  MANIFOLD_API_ORIGIN,
  MANIFOLD_API_REFRESH_TOKEN_KEY,
  MANIFOLD_API_STATUS_KEY,
  MANIFOLD_API_TOKEN_KEY,
  MANIFOLD_OAUTH_CLIENT_ID,
  MANIFOLD_OAUTH_TOKEN_ENDPOINT,
  type PersonalApiClient,
  type PersonalApiRequest,
} from "./api.js";
import { bridgeErrorDetail, PaperbackRuntimeError, paperbackError } from "./errors.js";

export { MANIFOLD_API_TOKEN_KEY } from "./api.js";

const JsonBodyString = Schema.fromJsonString(Schema.Unknown);

const scheduledPersonalRequesterEffect = (
  request: PersonalApiRequest,
): Effect.Effect<{ status: number; body: JsonValue }, PaperbackRuntimeError> =>
  Effect.gen(function* () {
    const scheduled = yield* fromPromise(() =>
      Application.scheduleRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(!(request.body === undefined) && { body: request.body }),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        // Offline and other transport failures reject with message-less bridge
        // values; label the request so device logs stay actionable.
        paperbackError(
          `Personal API request failed: ${request.method} ${request.url} (${bridgeErrorDetail(cause)})`,
        ),
      ),
    );
    const [response, bodyBuffer] = scheduled;
    const text = Application.arrayBufferToUTF8String(bodyBuffer);
    let body: JsonValue = text;
    const parsed = yield* Schema.decodeEffect(JsonBodyString)(text).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (parsed !== undefined && isJsonValue(parsed)) {
      body = parsed;
    }
    return { status: response.status, body };
  });

export const scheduledPersonalRequester = (
  request: PersonalApiRequest,
): Promise<{ status: number; body: JsonValue }> =>
  Effect.runPromise(scheduledPersonalRequesterEffect(request));

export const secureStateString = (key: string): string | undefined => {
  const value = Application.getSecureState(key);
  return isString(value) && value.trim().length > 0 ? value.trim() : undefined;
};

const clearManifoldSession = (): void => {
  Application.setSecureState("", MANIFOLD_API_ACCESS_TOKEN_KEY);
  Application.setSecureState("", MANIFOLD_API_REFRESH_TOKEN_KEY);
  Application.setSecureState("", MANIFOLD_API_ACCESS_EXPIRES_AT_KEY);
  Application.setState("Not connected", MANIFOLD_API_STATUS_KEY);
};

let refreshInFlight: Promise<string> | undefined;

const refreshManifoldSession = async (): Promise<string> => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const refreshToken = secureStateString(MANIFOLD_API_REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    throw new Error("Manifold session expired; login with GitHub in tracker settings");
  }

  const operation = (async () => {
    const response = await scheduledPersonalRequester({
      url: MANIFOLD_OAUTH_TOKEN_ENDPOINT,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: MANIFOLD_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
    if (response.status === 400 || response.status === 401) {
      clearManifoldSession();
    }
    if (response.status < 200 || response.status >= 300 || !isJsonObject(response.body)) {
      throw new Error("Manifold session refresh failed; login with GitHub in tracker settings");
    }

    const accessToken = stringField(response.body, "access_token");
    const replacementRefreshToken = stringField(response.body, "refresh_token");
    const expiresIn = numberField(response.body, "expires_in");
    if (!accessToken || !replacementRefreshToken || !expiresIn || expiresIn <= 0) {
      throw new Error("Manifold session refresh returned an invalid response");
    }
    Application.setSecureState(accessToken, MANIFOLD_API_ACCESS_TOKEN_KEY);
    Application.setSecureState(replacementRefreshToken, MANIFOLD_API_REFRESH_TOKEN_KEY);
    Application.setSecureState(
      String(Date.now() + expiresIn * 1000),
      MANIFOLD_API_ACCESS_EXPIRES_AT_KEY,
    );
    Application.setState("Connected", MANIFOLD_API_STATUS_KEY);
    return accessToken;
  })();

  refreshInFlight = operation;
  try {
    return await operation;
  } finally {
    if (refreshInFlight === operation) {
      refreshInFlight = undefined;
    }
  }
};

const authorizedPersonalRequester = async (
  request: PersonalApiRequest,
): Promise<{ status: number; body: JsonValue }> => {
  const accessToken = secureStateString(MANIFOLD_API_ACCESS_TOKEN_KEY);
  const legacyToken = secureStateString(MANIFOLD_API_TOKEN_KEY);
  let token = accessToken ?? legacyToken;
  if (!token) {
    throw new Error("Login with GitHub in tracker settings before using Manifold");
  }

  const refreshToken = secureStateString(MANIFOLD_API_REFRESH_TOKEN_KEY);
  const expiresAt = Number(secureStateString(MANIFOLD_API_ACCESS_EXPIRES_AT_KEY));
  if (
    accessToken &&
    refreshToken &&
    Number.isFinite(expiresAt) &&
    expiresAt <= Date.now() + 30_000
  ) {
    token = await refreshManifoldSession();
  }

  const withToken = (value: string): PersonalApiRequest => ({
    ...request,
    headers: { ...request.headers, authorization: `Bearer ${value}` },
  });
  const response = await scheduledPersonalRequester(withToken(token));
  if (response.status !== 401 || !accessToken || !refreshToken) {
    return response;
  }

  token = await refreshManifoldSession();
  return scheduledPersonalRequester(withToken(token));
};

export const configuredPersonalApi = (): PersonalApiClient => {
  const token =
    secureStateString(MANIFOLD_API_ACCESS_TOKEN_KEY) ?? secureStateString(MANIFOLD_API_TOKEN_KEY);
  if (!token) {
    throw new Error("Login with GitHub in tracker settings before using Manifold");
  }
  return createPersonalApiClient(authorizedPersonalRequester, {
    origin: MANIFOLD_API_ORIGIN,
    token,
  });
};
