import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { isJsonObject, isString, type JsonValue } from "@manifold/json";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const readEnvironment = async (): Promise<Record<string, string>> => {
  const file: Record<string, string> = {};
  try {
    const parsed = parseEnv(await readFile(resolve(repositoryRoot, "iac/.env"), "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (isString(value)) {
        file[key] = value;
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...file, ...process.env })) {
    if (key.startsWith("MANIFOLD_") && isString(value) && value.length > 0) {
      environment[key] = value;
    }
  }
  return environment;
};

try {
  const environment = await readEnvironment();
  if (!environment.MANIFOLD_TOKEN) {
    throw new Error("iac/.env must supply MANIFOLD_TOKEN");
  }

  const origin = environment.MANIFOLD_API_ORIGIN ?? "https://manifold.jfa.dev/api";
  const url = new URL(`${origin.replace(/\/$/u, "")}/v1/backups`);
  if (url.protocol !== "https:") {
    throw new Error("Backup API must use HTTPS");
  }

  const headers = { authorization: `Bearer ${environment.MANIFOLD_TOKEN}` };
  const created = await fetch(url, {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!created.ok) {
    throw new Error(`Backup creation failed (${created.status}): ${await created.text()}`);
  }

  const metadata: JsonValue = await created.json();
  if (!isJsonObject(metadata) || !isJsonObject(metadata.backup) || !isString(metadata.backup.key)) {
    throw new Error("Backup API returned invalid metadata");
  }

  const key = metadata.backup.key;
  const download = new URL(`${url}/download`);
  download.searchParams.set("key", key);
  const response = await fetch(download, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Backup download failed (${response.status})`);
  }

  const body = await response.text();
  const directory = resolve(environment.MANIFOLD_BACKUP_DIR ?? resolve(repositoryRoot, ".backups"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(
    directory,
    `${key.replace(/^registry\//u, "").replace(/\.json$/u, "")}.json`,
  );
  await writeFile(path, body, { mode: 0o600 });

  console.info(`R2 snapshot: ${key}`);
  console.info(`Local copy:  ${path}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Backup failed");
  process.exitCode = 1;
}
