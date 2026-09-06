import { open, mkdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { build } from "esbuild";
import { isJsonObject, isString, type JsonValue } from "@manifold/json";
import { MAX_REGISTRY_BACKUP_BYTES, parseRegistryBackup, sha256, REGISTRY_BACKUP_TABLE_COLUMNS, REGISTRY_BACKUP_TABLE_NAMES, type RegistryBackup } from "../src/registry-backup";
import { decodeArchive, encodeArchive, type RecoveryArchive } from "./recovery-archive";
import { verifyRecovery } from "./verify-recovery";

export const repositoryRoot = resolve(import.meta.dirname, "../..");

export const readRecoveryEnvironment = async (): Promise<Record<string, string>> => {
  const file = parseEnv(await readFile(resolve(repositoryRoot, "iac/.env"), "utf8"));
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...file, ...process.env })) {
    if (key.startsWith("MANIFOLD_") && value) {environment[key] = value;}
  }
  return environment;
};

export const buildRecoveryWorker = async (): Promise<string> => {
  const result = await build({
    entryPoints: [resolve(repositoryRoot, "api/src/recovery-worker.ts")],
    bundle: true, write: false, format: "esm", platform: "browser",
    target: "es2022", conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:*"],
  });
  return result.outputFiles[0].text;
};

const privateWrite = async (path: string, contents: string | Uint8Array): Promise<void> => {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
};

export const createRecoveryArchive = async (): Promise<string> => {
  const environment = await readRecoveryEnvironment();
  if (!environment.MANIFOLD_TOKEN || !environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET) {
    throw new Error("iac/.env must supply MANIFOLD_TOKEN and the original MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET");
  }
  const origin = environment.MANIFOLD_API_ORIGIN ?? "https://manifold.jfa.dev/api";
  const url = new URL(`${origin.replace(/\/$/u, "")}/v1/backups`);
  if (url.protocol !== "https:") {throw new Error("Backup API must use HTTPS");}
  const headers = { authorization: `Bearer ${environment.MANIFOLD_TOKEN}` };
  const startedAt = Date.now();
  const result = await fetch(url, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!result.ok) {throw new Error(`Backup creation failed (${result.status}); deployment is blocked`);}
  const metadata: JsonValue = await result.json();
  if (!isJsonObject(metadata) || !isJsonObject(metadata.backup) || !isString(metadata.backup.key)) {
    throw new Error("Backup API returned invalid metadata");
  }
  const download = new URL(`${url}/download`);
  download.searchParams.set("key", metadata.backup.key);
  const response = await fetch(download, { headers, redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {throw new Error(`Backup download failed (${response.status})`);}
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REGISTRY_BACKUP_BYTES) {throw new Error("Backup is too large");}
  if (await sha256(text) !== response.headers.get("x-backup-sha256")) {throw new Error("Downloaded backup checksum mismatch");}
  const input: JsonValue = JSON.parse(text);
  const backup = parseRegistryBackup(input);
  if (backup.createdAt < startedAt - 60_000 || backup.createdAt > Date.now() + 60_000) {
    throw new Error("Backup is not fresh; check server/local clocks");
  }
  return writeVerifiedArchive(backup, environment);
};

export const writeVerifiedArchive = async (backup: RegistryBackup, environment: Record<string, string>): Promise<string> => {
  const archive: RecoveryArchive = { backup, environment, worker: await buildRecoveryWorker() };
  const bytes = await encodeArchive(archive);
  const decoded = await decodeArchive(bytes);
  await verifyRecovery(decoded);
  const directory = resolve(environment.MANIFOLD_BACKUP_DIR ?? resolve(repositoryRoot, ".backups"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Prevent an accidentally configured path under node_modules or .alchemy.
  const actualDirectory = await realpath(directory);
  if (/(?:^|\/)(?:node_modules|\.alchemy)(?:\/|$)/u.test(actualDirectory)) {
    throw new Error("Backup directory must be independent of dependencies and Alchemy state");
  }
  const path = resolve(directory, `${backup.createdAt}-${crypto.randomUUID()}.recovery.json.gz`);
  await privateWrite(path, bytes);
  await decodeArchive(await readFile(path));
  console.info(`Verified recovery archive: ${path} (${backup.tables.canonical_entries.length} entries)`);
  return path;
};

export const prepareRecovery = async (archivePath: string, directory: string, workerName: string): Promise<void> => {
  if (!/^manifold-recovery-[a-z0-9-]+$/u.test(workerName)) {
    throw new Error("Use a NEW Worker name beginning manifold-recovery-");
  }
  const archive = await decodeArchive(await readFile(archivePath));
  await verifyRecovery(archive);
  await mkdir(directory, { mode: 0o700 });
  await privateWrite(resolve(directory, "worker.js"), archive.worker);
  await privateWrite(resolve(directory, "registry.json"), JSON.stringify(archive.backup));
  await privateWrite(resolve(directory, "secrets.json"), JSON.stringify(archive.environment));
  await privateWrite(resolve(directory, "wrangler.jsonc"), JSON.stringify({
    name: workerName, main: "worker.js", compatibility_date: "2026-08-20",
    compatibility_flags: ["nodejs_compat"], workers_dev: true,
    durable_objects: { bindings: [{ name: "MANIFOLD_SYNC", class_name: "ManifoldSync" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ManifoldSync"] }],
    observability: { enabled: true },
  }, null, 2));
  console.info(`Recovery verified and prepared in ${resolve(directory)}. Follow docs/registry-recovery.md to deploy and restore.`);
};

if (import.meta.main) {
  const [command, archivePath, directory, workerName] = process.argv.slice(2);
  try {
    if (command === "backup") {await createRecoveryArchive();}
    else if (command === "bootstrap-sql") {
      const environment = await readRecoveryEnvironment();
      if (!environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET) {throw new Error("Original encryption secret is required");}
      const fingerprint = await sha256(environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET);
      const tables = REGISTRY_BACKUP_TABLE_NAMES.map((table) => {
        const columns = REGISTRY_BACKUP_TABLE_COLUMNS[table].map((column) => `'${column}', ${column}`).join(", ");
        return `'${table}', json((SELECT json_group_array(json_object(${columns})) FROM ${table}))`;
      }).join(",\n");
      console.info(`SELECT json_object('version', 1, 'kind', 'manifold-sync', 'createdAt', unixepoch() * 1000, 'bookmark', 'manual-sql-export', 'databaseSize', 0, 'tokenKeyHash', '${fingerprint}', 'tables', json_object(${tables})) AS registry_backup;`);
    } else if (command === "pack" && archivePath) {
      const input: JsonValue = JSON.parse(await readFile(archivePath, "utf8"));
      await writeVerifiedArchive(parseRegistryBackup(input), await readRecoveryEnvironment());
    }
    else if (command === "verify" && archivePath) {
      await verifyRecovery(await decodeArchive(await readFile(archivePath)));
      console.info("Archive checksum, secrets, and fresh-namespace restore verified");
    } else if (command === "prepare" && archivePath && directory && workerName) {
      await prepareRecovery(archivePath, resolve(directory), workerName);
    } else if (command === "restore" && archivePath && directory) {
      // Here directory is the new Worker's HTTPS origin.
      const archive = await decodeArchive(await readFile(archivePath));
      const endpoint = new URL("/recovery/restore", directory);
      if (endpoint.protocol !== "https:") {throw new Error("Recovery endpoint must use HTTPS");}
      const result = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${archive.environment.MANIFOLD_TOKEN}`, "x-confirm-restore": "true" },
        body: JSON.stringify(archive.backup),
      });
      if (!result.ok) {throw new Error(`Recovery failed (${result.status}): ${await result.text()}`);}
      console.info("Registry restored. Background provider sync remains paused.");
    } else {throw new Error("Usage: registry-recovery.ts backup | bootstrap-sql | pack SNAPSHOT.json | verify ARCHIVE | prepare ARCHIVE NEW_DIR NEW_WORKER | restore ARCHIVE HTTPS_ORIGIN");}
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Recovery command failed");
    process.exitCode = 1;
  }
}
