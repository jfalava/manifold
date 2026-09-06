import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { isJsonObject, isJsonValue, isString } from "@manifold/json";
import { parseRegistryBackup, REGISTRY_BACKUP_TABLE_NAMES } from "../src/registry-backup";
import type { RecoveryArchive } from "./recovery-archive";

export const createRecoveryRuntime = (archive: RecoveryArchive): Miniflare => new Miniflare({
  unsafeInspectDurableObjects: true,
  workers: [{
    config: {
      name: "recovery-drill", type: "worker",
      compatibilityDate: "2026-08-20", compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: archive.worker } } },
      exports: { ManifoldSync: { type: "durable-object", storage: "sqlite" } },
      env: {
        ...Object.fromEntries(Object.entries(archive.environment).map(([name, value]) => [name, { type: "json" as const, value }])),
        MANIFOLD_SYNC: { type: "durable-object", worker: "recovery-drill", exportName: "ManifoldSync" },
        REGISTRY_BACKUPS: { type: "r2", name: "recovery-drill-backups" },
      },
    },
    dev: {
      outboundService: { type: "fetcher", handler: () => new MiniflareResponse("External requests disabled during recovery drill", { status: 503 }) },
    },
  }],
});

/** Run the archived application against a fresh, isolated workerd SQLite DO. */
export const verifyRecovery = async (archive: RecoveryArchive): Promise<void> => {
  const mf = createRecoveryRuntime(archive);
  const headers = { authorization: `Bearer ${archive.environment.MANIFOLD_TOKEN}`, "x-confirm-restore": "true" };
  try {
    const response = await mf.dispatchFetch("https://recovery.test/recovery/restore", {
      method: "POST", headers, body: JSON.stringify(archive.backup),
    });
    if (!response.ok) {throw new Error(`Recovery drill restore failed (${response.status}): ${await response.text()}`);}
    const saved = await mf.dispatchFetch("https://recovery.test/v1/backups", { method: "POST", headers });
    if (!saved.ok) {throw new Error(`Recovery drill snapshot failed (${saved.status}): ${await saved.text()}`);}
    const value = await saved.json();
    if (!isJsonObject(value) || !isJsonObject(value.backup)) {throw new Error("Recovery drill metadata is invalid");}
    const bucket = await mf.getR2Bucket("REGISTRY_BACKUPS");
    const key = value.backup.key;
    if (!isString(key)) {throw new Error("Recovery drill key is invalid");}
    const object = await bucket.get(key);
    if (!object) {throw new Error("Recovery drill did not write a snapshot");}
    const content = await object.json();
    if (!isJsonValue(content)) {throw new Error("Recovery drill snapshot is invalid JSON");}
    const restored = parseRegistryBackup(content);
    for (const table of REGISTRY_BACKUP_TABLE_NAMES) {
      const rows = (data: typeof archive.backup.tables) =>
        data[table].map((row) => JSON.stringify(row)).sort();
      if (JSON.stringify(rows(restored.tables)) !== JSON.stringify(rows(archive.backup.tables))) {
        throw new Error(`Recovery drill data mismatch: ${table}`);
      }
    }
  } finally {
    await mf.dispose();
  }
};
