# Manifold

An experimental canonical manga registry and [Paperback](https://paperback.moe/)
tracker. Manifold keeps identity, provider links, list state, and progress in one
place while native MangaDex and Comix extensions own reading and chapter updates.

> [!WARNING]
> This is **very** experimental and requires your own [infrastructure](https://manifold.jfa.dev/architecture/).

## Protecting and backing up the registry

The `ManifoldApi` host for the `ManifoldSync` Durable Object namespace and the
private R2 backup bucket use Alchemy `RemovalPolicy.retain()`, so stack
teardown does not delete them. The pinned Alchemy provider also aborts before
upload if a deploy would put `ManifoldSync` in `deleted_classes`.

Backups cover all ten persistent registry tables (including encrypted OAuth
tokens). After deployment, a daily R2 snapshot runs at 03:00 UTC. Create one on
demand with the authenticated API or:

```sh
bun run backup
```

That posts a fresh R2 snapshot and writes a local JSON copy under `.backups/`
(or `MANIFOLD_BACKUP_DIR`). Deploy and destroy are ordinary Alchemy commands;
they do not require a local archive.

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

Restore validates the encryption-key fingerprint, snapshots the current state
to R2 first, then replaces tables in one transaction. Provider sync stays paused
until you resume it:

```sh
curl -X POST -H "Authorization: Bearer $MANIFOLD_TOKEN" \
  -H 'Content-Type: application/json' -d '{"confirm":true}' \
  https://manifold.jfa.dev/api/v1/backups/resume
```

Cloudflare SQLite Durable Object [point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
covers about the last 30 days while the original namespace still exists. Inspect
`bun run plan` before `bun run deploy -- --yes`.
