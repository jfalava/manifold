import { ANILIST_GRAPHQL_ENDPOINT } from "@manifold/canonical/sources";
import {
  isJsonArray,
  isJsonObject,
  manifoldUserAgent,
  objectField,
  stringField,
  type JsonObject,
  type ManifoldUserAgentSurface,
} from "@manifold/json";
import { toJsonText } from "@manifold/json/text";
import { Effect } from "effect";

import {
  cliError,
  epochMillisNow,
  fromPromise,
  jsonFromResponseEffect,
  platformFetch,
  sleep,
  type CliEffectError,
} from "@/effect-kit";

/** AniList's degraded limit is ~30 req/min; 2.5 s spacing keeps every CLI caller at ≤24 req/min. */
const REQUEST_INTERVAL_MS = 2_500;
const MAX_RATE_LIMIT_RETRIES = 5;

let lastRequestAt = 0;

const throttleEffect = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const wait = REQUEST_INTERVAL_MS - (epochMillisNow() - lastRequestAt);

    if (wait > 0) {
      yield* sleep(wait);
    }

    lastRequestAt = epochMillisNow();
  });

/** POST one AniList GraphQL query through the process-wide rate limiter and return its `data`. */
export const aniListGraphqlEffect = (
  surface: ManifoldUserAgentSurface,
  token: string,
  query: string,
  variables: JsonObject = {},
  signal?: AbortSignal,
  attempt = 0,
): Effect.Effect<JsonObject, CliEffectError> =>
  Effect.gen(function* () {
    yield* throttleEffect();

    const response = yield* fromPromise(() =>
      platformFetch(ANILIST_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": manifoldUserAgent(surface),
        },
        body: toJsonText({ query, variables }),
        ...(signal !== undefined && { signal }),
      }),
    ).pipe(Effect.mapError((cause) => cliError(`AniList fetch failed: ${cause.message}`)));

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "5");
      yield* sleep(Math.max(retryAfter, 5) * 1000);

      return yield* aniListGraphqlEffect(surface, token, query, variables, signal, attempt + 1);
    }

    const raw = yield* jsonFromResponseEffect(response, `anilist.${surface}`);

    if (!isJsonObject(raw)) {
      return yield* cliError("AniList returned an invalid GraphQL response");
    }

    const errors = raw.errors;

    if (errors !== undefined && !isJsonArray(errors)) {
      return yield* cliError("AniList returned an invalid GraphQL errors envelope");
    }

    if (isJsonArray(errors) && errors.length > 0) {
      const messages = errors.map((error) =>
        isJsonObject(error) ? (stringField(error, "message") ?? "?") : "?",
      );

      return yield* cliError(messages.join("; "));
    }

    if (!response.ok) {
      return yield* cliError(`AniList HTTP ${response.status}`);
    }

    const data = objectField(raw, "data");

    if (!data) {
      return yield* cliError("AniList response missing data");
    }

    return data;
  });
