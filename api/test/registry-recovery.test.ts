import { beforeAll, describe, expect, it } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import { isJsonObject, isString } from "@manifold/json";
import { buildRecoveryWorker } from "../scripts/registry-recovery";
import { decodeArchive, encodeArchive, type RecoveryArchive } from "../scripts/recovery-archive";
import { createRecoveryRuntime, verifyRecovery } from "../scripts/verify-recovery";
import { backupKey, sha256, type RegistryBackup } from "../src/registry-backup";
import { encryptToken } from "../src/token-crypto";

const environment = {
  MANIFOLD_TOKEN: "recovery-test-token",
  MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: "recovery-test-encryption-secret",
};
const headers = { authorization: `Bearer ${environment.MANIFOLD_TOKEN}`, "x-confirm-restore": "true" };
let archive: RecoveryArchive;

beforeAll(async () => {
  const backup: RegistryBackup = {
    version: 1, kind: "manifold-sync", createdAt: Date.now(), bookmark: "test-bookmark", databaseSize: 4096,
    tokenKeyHash: await sha256(environment.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET),
    tables: {
      canonical_entries: [{ id: "entry-1", provider: "anilist", provider_id: "1", title: "Recovery 漫画", created_at: 10, updated_at: 20, tombstoned_at: null }],
      provider_links: [{ entry_id: "entry-1", provider: "mangadex", external_id: "md-1", title: null, updated_at: 20 }],
      read_events: [{ event_id: "event-1", entry_id: "entry-1", chapter_key: "chapter-1", read_at: 30 }],
      progress_state: [{ entry_id: "entry-1", chapter_key: "chapter-1", chapter_number: 1.5, volume_number: null, provider: "mangadex", source_chapter_id: "c-1", read_at: 30, version: 4 }],
      md_status_queue: [{ entry_id: "entry-1", created_at: 20, attempts: 2 }],
      md_feed_stats: [{ manga_id: "md-1", payload: "{}", computed_at: 20 }],
      oauth_tokens: [{ provider: "anilist", access_token: await encryptToken(environment, "restored-token"), refresh_token: null, token_type: "Bearer", expires_at: null, scope: null, updated_at: 20 }],
      list_state: [{ entry_id: "entry-1", status: "CURRENT", score: 8.5, notes: "keep this", started_at: "2026-01-01", completed_at: null, volume_progress: 2, media_list_entry_id: 12, updated_at: 30 }],
      sync_ops: [{ id: 42, op_id: "op-42", target: "anilist", kind: "list.update", origin: "device", payload: "{}", state: "pending", attempts: 2, last_error: "retry me", created_at: 20, updated_at: 30 }],
      list_events: [{ id: 93, entry_id: "entry-1", kind: "list.update", origin: "device", detail: null, created_at: 30 }],
    },
  };
  archive = { backup, environment, worker: await buildRecoveryWorker() };
}, 30_000);

describe("registry disaster recovery in workerd", () => {
  it("restores all ten populated tables from an offline archive into a fresh namespace", async () => {
    const decoded = await decodeArchive(await encodeArchive(archive));
    await verifyRecovery(decoded);
  }, 30_000);

  it("rejects corrupt archives and a lost encryption key before restoration", async () => {
    const bytes = await encodeArchive(archive);
    const corrupted = gzipSync(gunzipSync(bytes).toString().replace("Recovery", "Corrupt!"));
    await expect(decodeArchive(corrupted)).rejects.toThrow(/checksum/u);
    const wrongKey = { ...archive, environment: { ...environment, MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET: "wrong" } };
    await expect(decodeArchive(await encodeArchive(wrongKey))).rejects.toThrow(/original/u);
  });

  it("requires auth and confirmation, rejects a second offline import, and rolls back a failed SQL restore", async () => {
    const mf = createRecoveryRuntime(archive);
    try {
      const unauthorized = await mf.dispatchFetch("https://recovery.test/recovery/restore", { method: "POST", body: JSON.stringify(archive.backup) });
      expect(unauthorized.status).toBe(401);
      const unconfirmed = await mf.dispatchFetch("https://recovery.test/recovery/restore", { method: "POST", headers: { authorization: headers.authorization }, body: JSON.stringify(archive.backup) });
      expect(unconfirmed.status).toBe(400);
      const restored = await mf.dispatchFetch("https://recovery.test/recovery/restore", { method: "POST", headers, body: JSON.stringify(archive.backup) });
      expect(restored.status).toBe(200);
      const repeated = await mf.dispatchFetch("https://recovery.test/recovery/restore", { method: "POST", headers, body: JSON.stringify(archive.backup) });
      expect(repeated.status).toBe(400);

      // A duplicate PK fails after DELETEs and earlier INSERTs have run.
      const broken = { ...archive.backup, tables: { ...archive.backup.tables, list_events: [...archive.backup.tables.list_events, ...archive.backup.tables.list_events] } };
      const key = backupKey(Date.now());
      const bucket = await mf.getR2Bucket("REGISTRY_BACKUPS");
      await bucket.put(key, JSON.stringify(broken), { customMetadata: { sha256: await sha256(JSON.stringify(broken)) } });
      const failed = await mf.dispatchFetch("https://recovery.test/v1/backups/restore", { method: "POST", headers, body: JSON.stringify({ key, confirm: true }) });
      expect(failed.status).toBe(500);
      const result = await mf.dispatchFetch("https://recovery.test/v1/backups", { method: "POST", headers });
      expect(result.status).toBe(200);
      const data = await result.json();
      if (!isJsonObject(data) || !isJsonObject(data.backup) || !isString(data.backup.key)) {throw new Error("Missing backup metadata");}
      const object = await bucket.get(data.backup.key);
      const contents = await object?.json();
      if (!isJsonObject(contents)) {throw new Error("Missing snapshot");}
      expect(contents.tables).toEqual(archive.backup.tables);

      const storage = await mf.unsafeGetDurableObjectStorage("recovery-drill", "ManifoldSync", { name: "default" });
      const next = await storage.exec("INSERT INTO list_events(entry_id,kind,origin,created_at) VALUES ('entry-1','test','device',99) RETURNING id");
      expect(next).toEqual([{ id: 94 }]);

      await storage.exec("UPDATE canonical_entries SET title='newer live state'");
      const goodKey = backupKey(Date.now());
      const goodBody = JSON.stringify(archive.backup);
      await bucket.put(goodKey, goodBody, { customMetadata: { sha256: await sha256(goodBody) } });
      const success = await mf.dispatchFetch("https://recovery.test/v1/backups/restore", { method: "POST", headers, body: JSON.stringify({ key: goodKey, confirm: true }) });
      expect(success.status).toBe(200);
      expect(await storage.exec("SELECT title FROM canonical_entries")).toEqual([{ title: "Recovery 漫画" }]);
      expect(await storage.exec("SELECT id FROM list_events")).toEqual([{ id: 93 }]);
      const objects = await bucket.list();
      const snapshots = await Promise.all(objects.objects.map(async (item) => (await bucket.get(item.key))?.text()));
      expect(snapshots.some((text) => text?.includes("newer live state"))).toBe(true);
    } finally {await mf.dispose();}
  }, 30_000);
});
