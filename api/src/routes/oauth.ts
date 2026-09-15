import { Effect } from "effect";

import { errorMessage } from "@manifold/json";
import { json, tryPromise, type RouteContext, type RouteEffect } from "../http";

const oauthError = (error: string, description: string, status = 400): Response =>
  json({ error, error_description: description }, status);

const redirect = (location: string): Response =>
  new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });

export const handleOAuth = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;
    const sync = env.MANIFOLD_SYNC.getByName("default");

    if (
      path[0] === "v1" &&
      path[1] === "oauth" &&
      path.length === 3 &&
      path[2] === "authorize" &&
      request.method === "GET"
    ) {
      const start = yield* Effect.result(
        tryPromise(() =>
          sync.createManifoldOAuthAuthorization({
            clientId: url.searchParams.get("client_id") ?? "",
            redirectUri: url.searchParams.get("redirect_uri") ?? "",
            responseType: url.searchParams.get("response_type") ?? "",
            state: url.searchParams.get("state") ?? "",
            codeChallenge: url.searchParams.get("code_challenge") ?? "",
            codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
          }),
        ),
      );
      if (start._tag === "Failure") {
        return oauthError("invalid_request", start.failure.cause.message);
      }
      return redirect(start.success.authorizationUrl);
    }

    if (
      path[0] === "v1" &&
      path[1] === "oauth" &&
      path[2] === "github" &&
      path.length === 4 &&
      path[3] === "callback" &&
      request.method === "GET"
    ) {
      const state = url.searchParams.get("state");
      if (!state) {
        return oauthError("invalid_request", "OAuth callback is missing state");
      }
      const complete = yield* Effect.result(
        tryPromise(() =>
          sync.completeGithubOAuth(
            state,
            url.searchParams.get("code") ?? undefined,
            url.searchParams.get("error") ?? undefined,
          ),
        ),
      );
      if (complete._tag === "Failure") {
        return oauthError("invalid_grant", complete.failure.cause.message);
      }
      return redirect(complete.success.redirectUri);
    }

    if (
      path[0] === "v1" &&
      path[1] === "oauth" &&
      path.length === 3 &&
      path[2] === "token" &&
      request.method === "POST"
    ) {
      const body = yield* tryPromise(() => request.text());
      const form = new URLSearchParams(body);
      const token = yield* Effect.result(
        tryPromise(() =>
          sync.exchangeManifoldOAuthToken({
            grantType: form.get("grant_type") ?? "",
            clientId: form.get("client_id") ?? undefined,
            redirectUri: form.get("redirect_uri") ?? undefined,
            code: form.get("code") ?? undefined,
            codeVerifier: form.get("code_verifier") ?? undefined,
            refreshToken: form.get("refresh_token") ?? undefined,
          }),
        ),
      );
      if (token._tag === "Failure") {
        return oauthError("invalid_grant", token.failure.cause.message);
      }
      return json(token.success);
    }

    return null;
  }).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => oauthError("server_error", errorMessage(cause), 500)),
    ),
  );
