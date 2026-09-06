import { gzipSync, gunzipSync } from "node:zlib";
import { isJsonObject, isString, type JsonValue } from "@manifold/json";
import { parseRegistryBackup, sha256, type RegistryBackup } from "../src/registry-backup";
import { decryptToken } from "../src/token-crypto";

export interface RecoveryArchive {
  readonly backup: RegistryBackup;
  readonly environment: Readonly<Record<string, string>>;
  readonly worker: string;
}

export const encodeArchive = async (archive: RecoveryArchive): Promise<Uint8Array> => {
  const payload = JSON.stringify(archive);
  return gzipSync(JSON.stringify({ version: 1, sha256: await sha256(payload), payload }));
};

export const decodeArchive = async (bytes: Uint8Array): Promise<RecoveryArchive> => {
  const envelope: JsonValue = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString());
  if (!isJsonObject(envelope) || envelope.version !== 1 || !isString(envelope.payload)
    || envelope.sha256 !== await sha256(envelope.payload)) {
    throw new Error("Recovery archive checksum or version is invalid");
  }
  const payload: JsonValue = JSON.parse(envelope.payload);
  if (!isJsonObject(payload) || !isJsonObject(payload.environment) || !isString(payload.worker)) {
    throw new Error("Recovery archive is incomplete");
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.environment)) {
    if (!key.startsWith("MANIFOLD_") || !isString(value)) {
      throw new Error("Recovery archive environment is invalid");
    }
    environment[key] = value;
  }
  const backup = parseRegistryBackup(payload.backup);
  if (!environment.MANIFOLD_TOKEN || !environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET
    || await sha256(environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET) !== backup.tokenKeyHash) {
    throw new Error("Recovery archive is missing the original authentication/encryption secrets");
  }
  for (const row of backup.tables.oauth_tokens) {
    for (const column of ["access_token", "refresh_token"]) {
      if (row[column] === null) {continue;}
      const token = row[column];
      if (!isString(token)) {throw new Error("Backup token is invalid");}
      try {
        await decryptToken({ MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET }, token);
      } catch {
        throw new Error("The archived encryption secret cannot decrypt the backed-up OAuth tokens");
      }
    }
  }
  return { backup, environment, worker: payload.worker };
};
