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
manifold mal login                         # authorize MAL and save tokens in the OS keychain
manifold migrate wipe-mal                  # preview a MAL manga-only wipe
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

## MyAnimeList manga wipe

Register a MAL OAuth client with redirect URI `http://127.0.0.1:8766/callback`.
Use a separate CLI client rather than replacing the deployed API's redirect URI.
Set `MANIFOLD_MAL_CLIENT_ID` in `cli/.env`, plus `MANIFOLD_MAL_CLIENT_SECRET`
if the client requires it. From `cli/`:

```sh
bun index.ts mal login
bun index.ts migrate wipe-mal
```

Login prints a browser authorization URL and waits up to five minutes for the
loopback callback. Access and refresh tokens live in the OS keychain under
`manifold` / `mal-session`; refresh-token rotations are saved there too.
Alternatively, set `MANIFOLD_MAL_TOKEN` for a non-refreshing access-token override.
Do not share the deployed API's refresh token with the CLI.

The wipe defaults to a dry run. It scans every manga-list page and status,
including adult entries, before deleting anything. Anime, profile content,
privacy settings and AniList are untouched. No backup is created.

Before applying, disconnect the Manifold API's MAL connection in the admin
settings and pause other MAL writers. Let any in-flight writes finish.
When `MANIFOLD_TOKEN` is configured, the command checks `/v1/auth/mal` and refuses
to delete while that connection remains active. Without API credentials, it
cannot check the connection; you must verify it yourself.

```sh
bun index.ts migrate wipe-mal --apply --backup-paused
```

`--apply` is the confirmation, including in non-interactive execution. There is
no yes/no prompt or `--yes` flag. A single updating progress bar shows the count,
percentage, elapsed time and ETA using `cli-progress`.

`--backup-paused` acknowledges that other writers are stopped; it does not stop
them or override the API connection check. The command displays the account and
count, deletes sequentially with 1.5-second pacing, and re-fetches the list to
verify it is empty. It retries 429/5xx responses at most three times. On failure,
rerun the same command to scan and delete survivors. A DELETE 404 means the entry
is already absent. Keep writers disconnected until the subsequent import is done;
reconnecting can resume old backup operations.

The planned population source is AniList. This command only clears MAL; it does
not implement the AniList-to-MAL importer or switch the tracker's primary provider.
