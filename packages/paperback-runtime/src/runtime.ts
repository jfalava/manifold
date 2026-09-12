/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics tryCatchInEffectGen:off */
/** @effect-diagnostics unknownInEffectCatch:off */
import { isJsonValue, isString, type JsonValue } from "@manifold/json";
import { Effect } from "effect";
import { fromPromise } from "./from-promise.js";
import {
  createPersonalApiClient,
  MANIFOLD_API_ORIGIN,
  MANIFOLD_API_TOKEN_KEY,
  type PersonalApiClient,
  type PersonalApiRequest,
} from "./api.js";
import { bridgeErrorDetail } from "./errors.js";

export { MANIFOLD_API_TOKEN_KEY } from "./api.js";

const scheduledPersonalRequesterEffect = (
  request: PersonalApiRequest,
): Effect.Effect<{ status: number; body: JsonValue }, unknown> =>
  Effect.gen(function* () {
    const scheduled = yield* fromPromise(() =>
      Application.scheduleRequest({
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(!(request.body === undefined) && { body: request.body }),
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          // Offline and other transport failures reject with message-less bridge
          // values; label the request so device logs stay actionable.
          new Error(
            `Personal API request failed: ${request.method} ${request.url} (${bridgeErrorDetail(cause)})`,
          ),
      ),
    );
    const [response, bodyBuffer] = scheduled;
    const text = Application.arrayBufferToUTF8String(bodyBuffer);
    let body: JsonValue = text;
    try {
      // SAFETY: I/O JSON.parse of the personal API HTTP body at the scheduleRequest boundary.
      const parsed: unknown = JSON.parse(text);
      if (isJsonValue(parsed)) {
        body = parsed;
      }
    } catch {
      // The typed API error below still includes the HTTP status.
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

export const configuredPersonalApi = (): PersonalApiClient => {
  const token = secureStateString(MANIFOLD_API_TOKEN_KEY);
  if (!token) {
    throw new Error("Set the API token in manifold: tracker settings first");
  }
  return createPersonalApiClient(scheduledPersonalRequester, {
    origin: MANIFOLD_API_ORIGIN,
    token,
  });
};
