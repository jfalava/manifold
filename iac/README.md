# Secrets Store bindings

Manifold reads every secret exclusively through Cloudflare Secrets Store
bindings. Alchemy discovers and adopts the account Secrets Store as
`SharedSecretsStore` and deploys references to existing secrets, never their
values. No secret value lives in `iac/.env`, CI, or Alchemy state. The Store
provider creates the account store if none exists, but does not create secret
records or delete the shared store on teardown. The store must contain active
secrets with the Workers scope:

| Worker binding                           | Existing secret name                     | Consumers  |
| ---------------------------------------- | ---------------------------------------- | ---------- |
| `MANIFOLD_TOKEN`                         | `MANIFOLD_TOKEN`                         | api, admin |
| `MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET` | `MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET` | api        |
| `MANIFOLD_GITHUB_CLIENT_SECRET`          | `MANIFOLD_GITHUB_CLIENT_SECRET`          | api        |
| `MANIFOLD_ANILIST_CLIENT_SECRET`         | `MANIFOLD_ANILIST_CLIENT_SECRET`         | api        |
| `MANIFOLD_MAL_CLIENT_SECRET`             | `MANIFOLD_MAL_CLIENT_SECRET`             | api        |
| `MANIFOLD_MANGADEX_CLIENT_SECRET`        | `MANIFOLD_MANGADEX_CLIENT_SECRET`        | api        |
| `MANIFOLD_MANGADEX_USERNAME`             | `MANIFOLD_MANGADEX_USERNAME`             | api        |
| `MANIFOLD_MANGADEX_PASSWORD`             | `MANIFOLD_MANGADEX_PASSWORD`             | api        |
| `MANIFOLD_ADMIN_PANEL_ANALYTICS_API`     | `MANIFOLD_ADMIN_PANEL_ANALYTICS_API`     | admin      |

Public identifiers are store-bound too — OAuth client IDs, the redirect base
URL, and the GitHub access gate are the same kind of deployment-wide config and
move with the secrets, so `iac/.env` carries nothing but the deploy channel:

| Worker binding                           | Existing secret name                     | Consumers  |
| ---------------------------------------- | ---------------------------------------- | ---------- |
| `MANIFOLD_OAUTH_REDIRECT_BASE_URL`       | `MANIFOLD_OAUTH_REDIRECT_BASE_URL`       | api        |
| `MANIFOLD_GITHUB_CLIENT_ID`              | `MANIFOLD_GITHUB_CLIENT_ID`              | api        |
| `MANIFOLD_GITHUB_ALLOWED_USER_ID`        | `MANIFOLD_GITHUB_ALLOWED_USER_ID`        | api        |
| `MANIFOLD_ANILIST_CLIENT_ID`             | `MANIFOLD_ANILIST_CLIENT_ID`             | api        |
| `MANIFOLD_MAL_CLIENT_ID`                 | `MANIFOLD_MAL_CLIENT_ID`                 | api        |
| `MANIFOLD_MANGADEX_CLIENT_ID`            | `MANIFOLD_MANGADEX_CLIENT_ID`            | api        |

These values are not sensitive, but they rotate with the credentials they pair
with, so they live in the same store records. At runtime the Worker resolves a
`secrets_store_secret` binding with `.get()`; the API code accepts either a
plain string (tests, local doubles) or the binding via `readSecret`.

The deploy channel (`ENV`) is the only plain var in `iac/.env` (copy from
`iac/.env.example`; gitignored). It is deploy-time input that selects which
catalog channel to stage — no Worker reads it.

Create and rotate values in the Cloudflare Secrets Store outside this
deployment. CI needs permission to bind the secrets, not their values; the CLI
release workflow builds binaries and never touches deployment authorisation or
secret values.

## Local development

`bun run dev` pins `SharedSecretsStore` to Alchemy's remote provider so it
discovers the real account store instead of creating a local simulator store.
Worker bindings read the account secrets through Alchemy's remote Secrets Store
proxy, which requires Cloudflare authentication. Alchemy does not create or
seed secrets in this mode, and all stages see the production secret values —
use a separate development store/account if that is ever unacceptable.

`.dev.vars`, plaintext Worker secrets, and `MANIFOLD_*` secret env entries are
not fallback sources. Local runs always read the store through bindings.

## One-time migration from Alchemy-managed secrets

**Do not deploy the binding-only code until the old state records are
detached.** Removing managed `Secret` declarations otherwise schedules deletion
of the live cloud secrets; `retain()` applied in the same deployment as
declaration removal does not protect an existing record (retention must have
been persisted previously). The stack refuses to plan or deploy while any
`ManagedSecret*` state row remains.

With explicit operator approval, pause concurrent deployments and, from
`iac/`:

1. In Cloudflare, verify the account store contains every secret name from the
   table above with active status and Workers scope. Alchemy discovers the
   store ID automatically.
2. List state using the same Cloudflare account/profile as deployment. Use the
   actual Alchemy stage (default `production` for the deploy script).
   `--backend cloudflare` avoids evaluating the guarded stack during
   migration:

   ```sh
   bunx --no-install alchemy state list Manifold/production --recursive --backend cloudflare
   ```

3. Forget **only** the `ManagedSecret<NAME>` rows, one per secret name in the
   table. These commands delete Alchemy state, not Cloudflare resources. Never
   delete the stack, stage, store, or Worker records:

   ```sh
   bunx --no-install alchemy state delete Manifold/production/ManagedSecretMANIFOLD_TOKEN --backend cloudflare
   # …repeat for each ManagedSecret row listed above
   ```

   Add `--profile <deployment-profile>` to each command if deployment uses
   one. Repeat for other previously deployed stages before deploying them.

4. List state again to verify the rows are absent and the Cloudflare secrets
   still exist. Run `bun run plan`; it must bind existing secrets without
   creating, updating, or deleting store secrets. Deploy only this migrated
   code, then verify OAuth callbacks, MangaDex auth, and the admin analytics
   panel.
5. Strip the `MANIFOLD_*` secret values from `iac/.env` afterwards; the
   binding-only code no longer reads them.
