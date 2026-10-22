import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  validateManifoldWorkerUpload,
  validateSecretsStoreWrites,
} from "../src/cloudflare-upload-guard";

const uploadRequest = (scriptName: string, metadata?: string) => {
  const formData = new FormData();
  if (metadata !== undefined) {
    formData.append("metadata", metadata);
  }
  return HttpClientRequest.put(
    `https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/${scriptName}`,
  ).pipe(HttpClientRequest.setBody(HttpBody.formData(formData)));
};

const runValidation = (request: HttpClientRequest.HttpClientRequest) =>
  validateManifoldWorkerUpload(request);

test("blocks ManifoldSync deletion before the request is sent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const seen: string[] = [];
      const base = HttpClient.make((request) => {
        seen.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
        );
      });
      const guarded = HttpClient.tapRequest(base, validateManifoldWorkerUpload);
      const result = yield* Effect.exit(
        guarded.execute(
          uploadRequest("manifold-api", '{"migrations":{"deleted_classes":["ManifoldSync"]}}'),
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(seen).toHaveLength(0);
    }),
  ));

test("allows ordinary Worker uploads through unchanged", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const seen: string[] = [];
      const base = HttpClient.make((request) => {
        seen.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
        );
      });
      const guarded = HttpClient.tapRequest(base, validateManifoldWorkerUpload);

      yield* guarded.execute(
        uploadRequest("manifold-api", '{"migrations":{"deleted_classes":["OtherClass"]}}'),
      );
      yield* guarded.execute(
        uploadRequest("another-worker", '{"migrations":{"deleted_classes":["ManifoldSync"]}}'),
      );
      expect(seen).toHaveLength(2);
    }),
  ));

test("fails closed for malformed protected uploads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const missingMetadata = yield* Effect.exit(runValidation(uploadRequest("manifold-api")));
      const invalidMetadata = yield* Effect.exit(
        runValidation(uploadRequest("manifold-api", "not-json")),
      );

      expect(Exit.isFailure(missingMetadata)).toBe(true);
      expect(Exit.isFailure(invalidMetadata)).toBe(true);
    }),
  ));

const secretsStoreRequest = (
  method: "DELETE" | "POST" | "PUT" | "PATCH" | "GET",
  pathSuffix: string,
) =>
  HttpClientRequest.make(method)(
    `https://api.cloudflare.com/client/v4/accounts/account/secrets_store/${pathSuffix}`,
  );

const runSecretsStoreValidation = (request: HttpClientRequest.HttpClientRequest) =>
  validateSecretsStoreWrites(request);

test("blocks secret record deletion, cascade store deletion, and value writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const blocked: Array<[string, HttpClientRequest.HttpClientRequest]> = [
        [
          "single secret delete",
          secretsStoreRequest("DELETE", "stores/store-id/secrets/secret-id"),
        ],
        ["bulk secret delete", secretsStoreRequest("DELETE", "stores/store-id/secrets")],
        ["cascade store delete", secretsStoreRequest("DELETE", "stores/store-id")],
        ["bulk secret create", secretsStoreRequest("POST", "stores/store-id/secrets")],
        ["value rotation", secretsStoreRequest("PATCH", "stores/store-id/secrets/secret-id")],
        ["upsert", secretsStoreRequest("PUT", "stores/store-id/secrets/secret-id")],
      ];

      for (const [label, request] of blocked) {
        const result = yield* Effect.exit(runSecretsStoreValidation(request));
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(result.cause.toString()).toContain("binding-only deployment");
        } else {
          expect.unreachable(label);
        }
      }
    }),
  ));

test("allows Secrets Store reads and binding-relevant store operations through", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const allowed: Array<HttpClientRequest.HttpClientRequest> = [
        secretsStoreRequest("GET", "stores"),
        secretsStoreRequest("GET", "stores/store-id/secrets"),
        secretsStoreRequest("GET", "stores/store-id/secrets/secret-id"),
        secretsStoreRequest("POST", "stores"),
        // Store discovery/adopt metadata reconciliation stays allowed.
        secretsStoreRequest("PATCH", "stores/store-id"),
      ];

      for (const request of allowed) {
        const result = yield* Effect.exit(runSecretsStoreValidation(request));
        expect(Exit.isSuccess(result)).toBe(true);
      }
    }),
  ));
