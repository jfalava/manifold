# Manifold

An experimental canonical manga registry and [Paperback](https://paperback.moe/)
tracker. Manifold keeps identity, provider links, list state, and progress in one
place while native MangaDex and Comix extensions own reading and chapter updates.

> [!WARNING]
> This is **very** experimental and requires your own [infrastructure](https://manifold.jfa.dev/architecture/).

## MyAnimeList status backup

Tracker list-state updates enqueue a Worker-side `mal.status` backup. Connect
MAL through Credentials first. AniList/Manifold remain authoritative: this flow
never imports MAL list state, creates a MAL-origin registry entry, or merges
canonical entries. It only updates MAL status (including the rereading flag),
not scores, notes, progress, or deletions.

An existing MAL binding wins, followed by AniList's `idMal`. Otherwise the Worker
searches all supplied title variants and registry link titles. It accepts a
unique normalized title/alias match or uses the MangaDex resolver's embedding
model and confidence rules (score ≥ 0.85, margin ≥ 0.06). Conflicting exact
matches and close semantic ties stay unbound. Automatic binding never takes an
ID owned by another registry entry.

The tracker supplies AniList's ID and English/romaji/native/synonym titles in
the existing status mutation response; the Worker does not need AniList access.
New updates supersede older backup work, and retries read the latest list state.
Failures do not fail tracker updates. Inspect `GET /v1/ops?target=mal`; after five
failed attempts the operation is blocked. Fix credentials or the binding, then
use the existing per-operation retry endpoint (`POST /v1/ops/:opId/retry`), or
send another tracker update. Registry restore pauses these backups too.

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
