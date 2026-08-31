# manifold

The Manga Sync CLI (`@manifold/manifold-cli`): migrations, op-log triage, drift
reconciliation, and canonical registry backfill.

Full documentation lives in the docs site under **The manifold CLI**
(`apps/docs/src/content/docs/cli.mdx`). Quick reference:

```text
bun run manifold <subcommand> [flags]

manifold migrate md2al | al2md | wipe-al   # AniList <-> MangaDex migrations (dry-run by default)
manifold ops pending | retry               # op-log triage
manifold reconcile diff                    # live AniList list vs registry (read-only)
manifold registry import                   # snapshot AniList list into the registry
manifold registry comix                    # backfill comix hid links via local Chrome
```

Credentials resolve flag → env name → `ALCHEMY_SECRET_`-prefixed env name
(`MANIFOLD_TOKEN`, `ANILIST_TOKEN`, `MANIFOLD_API_ORIGIN`). AniList
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
