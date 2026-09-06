# Manifold

An experimental canonical manga registry and [Paperback](https://paperback.moe/)
tracker. Manifold keeps identity, provider links, list state, and progress in one
place while native MangaDex and Comix extensions own reading and chapter updates.

> [!WARNING]
> This is **very** experimental and requires your own [infrastructure](https://manifold.jfa.dev/architecture/).

## Protecting and backing up the registry

The `ManifoldApi` host for the `ManifoldSync` Durable Object namespace and the
private R2 backup bucket are configured with Alchemy's
`RemovalPolicy.retain()`. Removing or renaming either declaration, or
destroying the Alchemy stack, therefore does not ask Cloudflare to delete the
underlying data. It does not protect against deliberate deletion through the
Cloudflare API/dashboard or direct storage deletion. The pinned Alchemy
provider also aborts before upload if a deploy ever tries to send
`ManifoldSync` in `deleted_classes`.

Backups contain all ten persistent registry tables, including encrypted OAuth
tokens. Daily R2 snapshots run at 03:00 UTC after deployment. `bun run deploy`
and `bun run destroy` first create a fresh snapshot, verify its checksum, and
restore it into an isolated local SQLite Durable Object. They also write a
private archive outside Cloudflare with the snapshot, original secrets, and a
self-contained recovery Worker. Deployment stops if any step fails.

Archives default to `.backups/`. Set `MANIFOLD_BACKUP_DIR` in `iac/.env` to a
backup disk or backed-up directory. Archives contain secrets and are written
with owner-only permissions. Keep them private. R2 copies survive loss of the
local machine; independent archives survive loss of the Cloudflare account.

```sh
bun run backup
bun run backup:verify /absolute/path/to/ARCHIVE.recovery.json.gz
```

The authenticated API also supports R2 snapshots:

```sh
curl -H "Authorization: Bearer $MANIFOLD_TOKEN" \
  https://manifold.jfa.dev/api/v1/backups

curl -X POST -H "Authorization: Bearer $MANIFOLD_TOKEN" \
  https://manifold.jfa.dev/api/v1/backups

# Replace the key with one returned by GET /api/v1/backups.
curl -X POST -H "Authorization: Bearer $MANIFOLD_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"key":"registry/TIMESTAMP-UUID.json","confirm":true}' \
  https://manifold.jfa.dev/api/v1/backups/restore
```

Restore first backs up the current state and verifies the original token
encryption key. Provider sync stays paused until explicitly resumed. Managed
Secrets Store secrets are retained along with the Worker and bucket.

See [the recovery runbook](docs/registry-recovery.md) for the first deployment,
restoring into a fresh namespace without Alchemy or the existing API, and
resuming sync. SQLite Durable Object point-in-time recovery covers the past
30 days as an additional recovery option. Inspect `bun run plan` before
`CI=1 bun run deploy -- --yes`.
