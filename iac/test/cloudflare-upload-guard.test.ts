import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { validateManifoldWorkerUpload } from "../src/cloudflare-upload-guard";

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
