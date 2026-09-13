/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics processEnv:off */
import { errorMessage, isJsonValue, type JsonValue } from "@manifold/json";
import { Data, DateTime, Effect, Option, Schema } from "effect";

const JsonBodyString = Schema.fromJsonString(Schema.Unknown);

export class CliEffectError extends Data.TaggedError("CliEffectError")<{
  readonly message: string;
}> {}

export const cliError = (message: string): CliEffectError => new CliEffectError({ message });

/** Promise boundary: rejections become typed failures (not defects). */
export const fromPromise = <A>(action: () => Promise<A>): Effect.Effect<A, CliEffectError> =>
  Effect.tryPromise({ try: action, catch: (cause) => cliError(errorMessage(cause)) });

/** Run an Effect at a CLI host boundary (command handlers, scripts). */
export const runHost = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** Encode a JSON-serializable value to a request body string. */
export const jsonBodyString = (value: JsonValue): string =>
  Effect.runSync(Schema.encodeEffect(JsonBodyString)(value));

/** Wall-clock millis (sync host read of the Effect clock). */
export const epochMillisNow = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

/** Sleep as an Effect (replaces `new Promise` + `setTimeout`). */
export const sleep = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`);

/** Promise sleep for third-party callbacks that cannot take an Effect. */
export const sleepPromise = (ms: number): Promise<void> => Effect.runPromise(sleep(ms));

/**
 * Read process env only at the Config/bootstrap boundary.
 * Prefer {@link envOption} / flag resolution over scattering process.env.
 */
export const envOption = (name: string): Option.Option<string> => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? Option.some(value) : Option.none();
};

export const envString = (name: string): string | undefined =>
  Option.getOrUndefined(envOption(name));

/** Decode wire JSON (already JsonValue) with Option. */
export const decodeJsonOption = <A>(
  schema: Schema.ConstraintDecoder<A>,
  body: JsonValue,
): Option.Option<A> => {
  const untrusted: unknown = body;
  return Schema.decodeUnknownOption(schema)(untrusted);
};

/** Decode or fail with a labeled error for host boundaries. */
export const decodeJsonOrThrow = <A>(
  schema: Schema.ConstraintDecoder<A>,
  body: JsonValue,
  label: string,
): A => {
  const decoded = decodeJsonOption(schema, body);
  if (Option.isNone(decoded)) {
    throw cliError(`${label}: schema rejected body`);
  }
  return decoded.value;
};

/** Parse JSON text into JsonValue or throw. */
export const parseJsonValue = (text: string, label = "json"): JsonValue => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw cliError(`${label}: invalid JSON`);
  }
  if (!isJsonValue(raw)) {
    throw cliError(`${label}: not a JSON value`);
  }
  return raw;
};

/**
 * Fetch entry used by the CLI. Reads `globalThis.fetch` on each call so tests
 * can `vi.stubGlobal("fetch", …)` without rebinding a frozen reference.
 */
export const platformFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

/** UUID for OAuth state / PKCE (sync host). */
export const newId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // RFC 4122 version 4
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Coerce response.json() result to JsonValue. */
export const jsonFromResponseEffect = (
  response: Response,
  label = "response",
): Effect.Effect<JsonValue, CliEffectError> =>
  Effect.gen(function* () {
    const raw: unknown = yield* fromPromise(() => response.json()).pipe(
      Effect.mapError((cause) => cliError(`${label}: ${errorMessage(cause)}`)),
    );
    if (!isJsonValue(raw)) {
      return yield* cliError(`${label}: not a JSON value`);
    }
    return raw;
  });

export const jsonFromResponse = (response: Response, label = "response"): Promise<JsonValue> =>
  Effect.runPromise(jsonFromResponseEffect(response, label));
