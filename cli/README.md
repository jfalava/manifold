# manifold

The Manga Sync CLI (`@manifold/manifold-cli`): migrations, op-log triage, drift
reconciliation, and canonical registry backfill.

Full documentation lives in the docs site under **The manifold CLI**
(`docs/src/content/docs/cli/index.mdx`). Quick reference:

```text
bun run manifold <subcommand> [flags]

manifold migrate md2al                     # MangaDex library → private AniList entries
manifold migrate anilist-to-mangadex       # AniList list → MangaDex statuses + markers
manifold migrate al2pas5                   # AniList list → Paperback .pas5 backup
manifold migrate wipe-al                   # delete AniList manga state (destructive)
manifold stale-status                      # move stale MangaDex titles to a new status
manifold unfollow-dropped                  # unfollow MangaDex titles by status
manifold ops pending | retry               # op-log triage
manifold reconcile diff                    # live AniList list vs registry (read-only)
manifold registry import                   # snapshot AniList list into the registry
manifold registry mangadex                 # backfill MangaDex provider links
manifold registry comix                    # backfill Comix hid links via local Chrome
```

Credentials resolve flag → `MANIFOLD_*` env name
(`MANIFOLD_TOKEN`, `MANIFOLD_ANILIST_TOKEN`, `MANIFOLD_API_ORIGIN`). AniList
writes run locally — AniList blocks Cloudflare Worker egress IPs.

`registry comix` does not paste `cf_clearance` into `fetch`. It opens a
headed Chrome window with a dedicated `~/.manifold/comix-chrome` profile
(Chrome 136+ ignores `--remote-debugging-port` on the default profile),
captures `/browse` the same way the Paperback source does, and stores the
harvested jar in `Bun.secrets` until `cf_clearance` expires.

```text
bun run manifold registry comix
```

If Cloudflare appears, solve it in that new Chrome window and press Enter.
