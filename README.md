# Manga sync monorepo

Personal-first synchronization for a unified Paperback source.

The first authentication slice supports browser OAuth for AniList and
MyAnimeList, plus personal-client authentication for MangaDex. Upstream tokens
are owned by the personal Durable Object and are encrypted before storage.
Comix access is established in Paperback's device-local in-app browser.

## Workspace layout

```text
iac/                   Alchemy stack and production deployment scripts
apps/router/           manifold.jfa.dev path router and Worker service bindings
apps/api/              Sync API Worker, ManifoldSync DO, Paperback catalog, tests
apps/migration/        manifold CLI: migrations, op-log triage, drift reconcile, registry backfill
apps/docs/             Nimbus Astro documentation and Paperback source surface
packages/canonical/   AniList/MAL identity and progress contracts
packages/mangadex/    MangaDex API/source adapter
packages/comix/       Comix API/browser-backed source adapter
packages/paperback-comix     Paperback Comix source implementation
packages/paperback-runtime   Shared device runtime for Paperback plugins
source/                      ManifoldSource content extension (inkdex-shaped)
tracker/                     ManifoldTracker tracker extension (inkdex-shaped)
```

Only `iac` owns the production deployment. It provisions three Workers and
one static asset site: `ManifoldRouter` owns the `manifold.jfa.dev` custom domain,
`SyncApi` owns the HTTP API, Durable Object, and Paperback catalog,
and `ManifoldDocs` serves the docs mount. There is no separate dev stack or
dev endpoint.

The router currently mounts `/api/*` and `/paperback/*` to `SyncApi`, and
`/docs/*` to `ManifoldDocs`. Provider cookies remain device-local for
Paperback’s in-app browser; they are not sent through the sync API.

## AniList wipe (`wipe-al`)

Port of github.com/criccadamus/anilist-manga-bulk-delete: deletes **all**
manga list entries and all manga-related activities (list + text posts
matching manga keywords) on the token's account. Anime entries are never
touched. Interactive confirmation unless `--yes`.

```sh
bun run --cwd apps/migration wipe-al            # prompts before deleting
bun run --cwd apps/migration wipe-al -- --yes   # scripted runs
```

## Migration tools

Two directions, one CLI (`apps/migration`, dry run by default — add `--apply`
to write):

### MangaDex → AniList (primary)

Mirrors your MangaDex library into AniList as private list entries: statuses
plus optional chapter-progress push from MD read markers. Resumable via
`.tmp` snapshots; matching cascade links.al → links.mal → title search;
AniList writes 1.2s-spaced with 429 retry handling.

```sh
bun run migrate:md2al                  # dry run
bun run migrate:md2al -- --apply       # apply statuses + progress
bun run migrate:md2al -- --skip-progress --apply   # statuses only
```

MangaDex auth falls back to the password-grant credentials in `iac/.env`,
or pass `--mangadex-token` with a personal token having `manga.read` scope.

### AniList → MangaDex (reverse utility)

Brings your MangaDex library up to parity with AniList. Runs entirely locally
because AniList blocks Cloudflare worker IPs.

```sh
bun run migrate:al2md            # dry run using iac/.env credentials
bun run migrate:al2md -- --apply # apply statuses + chapter-marker backfill
```

Requires `ANILIST_TOKEN` (or `--anilist-token`); see the PIN-flow note in
`--help`. Matching cascade per entry: MangaDex `links.al` direct hit, then
normalized title search; statuses map CURRENT→reading, REPEATING→re_reading,
PAUSED→on_hold, PLANNING→plan_to_read, and backfill marks read every chapter
numbered up to the AniList progress value.

Secrets live in `iac/.env`; see `iac/.env.example`.

## Tooling

- Bun workspaces
- TypeScript project references
- Effect `4.0.0-rc.110`
- Alchemy `2.0.0-beta.72` for Cloudflare infrastructure as code
- Vitest for deploy-free unit tests

## Commands

```sh
bun install
bun run typecheck
bun run test:oauth
bun run test:canonical
bun run test:paperback
bun run build:docs
bun run test
bun run plan
bun run deploy
bun run migrate
```

`test` and `deploy` use Alchemy’s Cloudflare profile. Review the
Alchemy plan before deploying; no Wrangler configuration or deployment script
is part of this repository.

`plan` and `deploy` always rebuild the Paperback catalog first: its bundle
outputs are gitignored, so Alchemy's build cache alone cannot detect extension
changes. Non-interactive runs need an explicit approval flag:
`bun run deploy -- --yes`.
