import { Effect, Schema } from "effect";
import {
  ErrorBody,
  RegistryBackupResponse,
  RegistryBackupRestoreResponse,
  RegistryBackupsResponse,
  RestoreRegistryBackupInput,
} from "@manifold/contract";

import {
  jsonEncoded,
  parseJson,
  tryPromise,
  type RouteContext,
  type RouteEffect,
} from "../http";
import { isRegistryBackupKey } from "../registry-backup";

export const handleBackups = (ctx: RouteContext): RouteEffect =>
  Effect.gen(function* () {
    const { path, request, env } = ctx;
    if (path[0] !== "v1" || path[1] !== "backups") {
      return null;
    }

    const sync = env.MANIFOLD_SYNC.getByName("default");
    if (path.length === 3 && path[2] === "download" && request.method === "GET") {
      const key = ctx.url.searchParams.get("key") ?? "";
      if (!isRegistryBackupKey(key)) {
        return jsonEncoded(ErrorBody, { error: "Invalid registry backup key" }, 400);
      }
      const bucket = env.REGISTRY_BACKUPS;
      if (!bucket) {throw new Error("Registry backup bucket is not configured");}
      const object = yield* tryPromise(() => bucket.get(key));
      if (!object) {return jsonEncoded(ErrorBody, { error: "Backup not found" }, 404);}
      return new Response(object.body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-backup-sha256": object.customMetadata?.sha256 ?? "",
        },
      });
    }

    if (path.length === 3 && path[2] === "resume" && request.method === "POST") {
      const input = yield* parseJson(request);
      yield* Schema.decodeUnknownEffect(Schema.Struct({ confirm: Schema.Literal(true) }))(input);
      yield* tryPromise(() => sync.resumeRegistrySync());
      return new Response(null, { status: 204 });
    }
    if (path.length === 2 && request.method === "GET") {
      return jsonEncoded(RegistryBackupsResponse, {
        backups: yield* tryPromise(() => sync.listBackups()),
      });
    }

    if (path.length === 2 && request.method === "POST") {
      return jsonEncoded(RegistryBackupResponse, {
        backup: yield* tryPromise(() => sync.backupRegistry()),
      });
    }

    if (path.length === 3 && path[2] === "restore" && request.method === "POST") {
      const raw = yield* parseJson(request);
      const input = yield* Schema.decodeUnknownEffect(RestoreRegistryBackupInput)(raw);
      return jsonEncoded(RegistryBackupRestoreResponse, {
        restored: true as const,
        backup: yield* tryPromise(() => sync.restoreBackup(input.key)),
      });
    }

    return jsonEncoded(ErrorBody, { error: "Not found" }, 404);
  });
