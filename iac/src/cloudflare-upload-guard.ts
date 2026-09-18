import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Layer from "effect/Layer";

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: JsonValue): value is string {
  return typeof value === "string";
}

const isStringArray = (value: JsonValue): value is readonly string[] =>
  Array.isArray(value) && value.every(isString);

const isManifoldWorkerUpload = (request: HttpClientRequest.HttpClientRequest): boolean => {
  if (request.method !== "PUT") {
    return false;
  }

  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  return path.at(-3) === "workers" && path.at(-2) === "scripts" && path.at(-1) === "manifold-api";
};

const rejectMalformedUpload = (reason: string): Effect.Effect<never> =>
  Effect.die(new Error(`Refusing manifold-api upload: ${reason}`));

/** Reject a deploy that would delete ManifoldSync before it reaches Cloudflare. */
export const validateManifoldWorkerUpload = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<void> => {
  if (!isManifoldWorkerUpload(request)) {
    return Effect.void;
  }

  if (request.body._tag !== "FormData") {
    return rejectMalformedUpload("expected a multipart upload");
  }

  const metadataPart = request.body.formData.get("metadata");
  if (metadataPart === null || metadataPart instanceof Blob) {
    return rejectMalformedUpload("metadata is missing or not JSON text");
  }

  let metadata: unknown;
  try {
    // SAFETY: JSON.parse is immediately narrowed with the JSON object predicate below.
    metadata = JSON.parse(metadataPart);
  } catch {
    return rejectMalformedUpload("metadata is not valid JSON");
  }

  if (!isJsonObject(metadata)) {
    return rejectMalformedUpload("metadata must be a JSON object");
  }

  const migrations = metadata.migrations;
  if (migrations === undefined) {
    return Effect.void;
  }
  if (!isJsonObject(migrations)) {
    return rejectMalformedUpload("migrations must be a JSON object");
  }

  const deletedClasses = migrations.deleted_classes ?? migrations.deletedClasses;
  if (deletedClasses === undefined) {
    return Effect.void;
  }
  if (!isStringArray(deletedClasses)) {
    return rejectMalformedUpload("migrations.deleted_classes must be an array of class names");
  }
  if (deletedClasses.includes("ManifoldSync")) {
    return Effect.die(
      new Error(
        "Refusing to delete manifold-api/ManifoldSync: Durable Object class deletion is blocked.",
      ),
    );
  }

  return Effect.void;
};

/** Add the repository-owned upload guard to Alchemy's ambient HTTP client. */
export const guardedCloudflareHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.tapRequest(client, validateManifoldWorkerUpload),
  ),
);
