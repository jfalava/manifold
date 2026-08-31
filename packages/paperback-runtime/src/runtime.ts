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
  let body: unknown = text;
  try {
    // SAFETY: test/double or boundary cast through unknown to unknown
    body = JSON.parse(text) as unknown;
  } catch {
    // The typed API error below still includes the HTTP status.
  }
  return { status: response.status, body };
};

export const secureStateString = (key: string): string | undefined => {
  const value = Application.getSecureState(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

export const configuredPersonalApi = (): PersonalApiClient => {
  const token = secureStateString(MANIFOLD_API_TOKEN_KEY);
  if (!token) {
    throw new Error("Set the API token in manifold: source settings first");
  }
  return createPersonalApiClient(scheduledPersonalRequester, {
    origin: MANIFOLD_API_ORIGIN,
    token,
  });
};
