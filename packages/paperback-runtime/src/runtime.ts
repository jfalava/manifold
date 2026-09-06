import { isJsonValue, isString, type JsonValue } from "@manifold/json";
import {
  createPersonalApiClient,
  MANIFOLD_API_ORIGIN,
  MANIFOLD_API_TOKEN_KEY,
  type PersonalApiClient,
  type PersonalApiRequest,
} from "./api.js";

export { MANIFOLD_API_TOKEN_KEY } from "./api.js";

export const scheduledPersonalRequester = async (
  request: PersonalApiRequest,
) => {
  const [response, bodyBuffer] = await Application.scheduleRequest({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(!(request.body === undefined) && { body: request.body }),
  });
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
