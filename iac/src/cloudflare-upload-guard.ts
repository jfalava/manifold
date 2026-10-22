import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";

/** Secrets Store secret records are created and rotated only from the
 * Cloudflare dashboard. Deployments bind existing records exclusively, so any
 * attempt to create, rotate, delete, or cascade-delete a secret record through
 * this deployment is wrong — including a removed managed-Secret declaration
 * reconciling as a delete against the live secrets. Blocked:
 *   DELETE /accounts/{a}/secrets_store/stores/{store_id}[/force…]
 *     — store delete cascades its secrets,
 *   DELETE /accounts/{a}/secrets_store/stores/{store_id}/secrets[/{secret_id}]
 *     — bulk and single secret-record deletes,
 *   POST/PUT/PATCH under …/stores/{store_id}/secrets…
 *     — secret-record creates and value rotations. */
const isSecretsStoreSecretWrite = (request: HttpClientRequest.HttpClientRequest): boolean => {
  if (request.method === "GET") {
    return false;
  }
  const segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const storeRoot = segments.indexOf("secrets_store") + 1; // index of "stores"
  if (storeRoot === 0 || segments[storeRoot] !== "stores") {
    return false;
  }
  const rest = segments.length - storeRoot;
  if (request.method === "DELETE") {
    return rest === 2 || rest === 3 || rest === 4;
  }
  // POST/PUT/PATCH: writes into the store's secrets collection only; other
  // store-level calls (e.g. store metadata PATCH) stay allowed.
  return segments[storeRoot + 2] === "secrets";
};

const secretsStoreRefuseReason = (request: HttpClientRequest.HttpClientRequest): string =>
  request.method === "DELETE"
    ? "secret-record deletion is blocked (binding-only deployment)"
    : "secret-record value writes are blocked (binding-only deployment)";

/** Reject any Secrets Store secret-record mutation before it reaches Cloudflare. */
export const validateSecretsStoreWrites = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<void> =>
  isSecretsStoreSecretWrite(request)
    ? Effect.die(
        new Error(
          `Refusing Secrets Store change (${request.method} ${pathOf(request)}): ${secretsStoreRefuseReason(request)}. Create or rotate values in the Cloudflare Secrets Store outside deployment.`,
        ),
      )
    : Effect.void;

const pathOf = (request: HttpClientRequest.HttpClientRequest): string =>
  new URL(request.url).pathname;

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
    HttpClient.tapRequest(client, (request) =>
      Effect.andThen(validateManifoldWorkerUpload(request), validateSecretsStoreWrites(request)),
    ),
  ),
);
