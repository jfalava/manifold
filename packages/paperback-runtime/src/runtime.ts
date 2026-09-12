/** Paperback / device host callbacks are async by Application contract. */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import { isJsonValue, isString, type JsonValue } from "@manifold/json";
import {
  createPersonalApiClient,
  MANIFOLD_API_ORIGIN,
  MANIFOLD_API_TOKEN_KEY,
  type PersonalApiClient,
  type PersonalApiRequest,
} from "./api.js";
import { bridgeErrorDetail } from "./errors.js";

export { MANIFOLD_API_TOKEN_KEY } from "./api.js";

export const scheduledPersonalRequester = async (request: PersonalApiRequest) => {
  let scheduled: Awaited<ReturnType<typeof Application.scheduleRequest>>;
  try {
    scheduled = await Application.scheduleRequest({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(!(request.body === undefined) && { body: request.body }),
    });
  } catch (cause) {
    // Offline and other transport failures reject with message-less bridge
    // values; label the request so device logs stay actionable.
    throw new Error(
      `Personal API request failed: ${request.method} ${request.url} (${bridgeErrorDetail(cause)})`,
    );
  }
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
};

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
