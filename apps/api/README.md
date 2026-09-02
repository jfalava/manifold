# Manga API

HTTP Worker for the sync API, OAuth, registry, and Paperback catalog.

## Stack

- Bun for package management, local development, and scripts
- TypeScript on Cloudflare Workers
- Effect `4.0.0-rc.110` for schemas, errorful workflows, and runtime composition
- One SQLite-backed Durable Object named `ManifoldSync` for the personal sync state
- Vitest for runtime/provider tests

Cloudflare infrastructure and Alchemy deployment scripts live under the
repository-level `iac/` package. This package contains only the Worker runtime
and personal sync behavior; its source has no infrastructure deployment
dependency.

The Worker is the stateless HTTP boundary. The Durable Object is addressed as
`personal` for now, but the API is structured so it can become one object per
authenticated user later.

## Current vertical slice

The personal Worker can search AniList and MyAnimeList through the canonical
source layer. AniList search is available with its public GraphQL API; MAL
search requires `MAL_CLIENT_ID`. Provider failures are returned per provider so
an unavailable MAL integration does not hide usable AniList results.

The Durable Object stores:

- canonical entries such as `anilist:123`
- one MangaDex and/or Comix link per canonical entry
- precise local reading progress
- idempotent read events
- pending MangaDex progress outbox records

Read events commit local progress and the outbox record in the Durable Object
before the request succeeds. A Durable Object alarm drains the outbox and marks
the corresponding MangaDex chapter read with the encrypted MangaDex token.

## OAuth connections

The personal stack supports browser OAuth for AniList and MyAnimeList. Both
providers redirect back to the Worker, and the Durable Object stores encrypted
access and refresh tokens. MangaDex does not currently expose its public-client
browser flow, so the personal account uses a registered personal client and an
explicit password-grant bootstrap. Tokens are never returned by the API.

MyAnimeList currently requires the `plain` PKCE challenge method, so the
adapter follows that provider-specific limitation.

Copy `iac/.env.example` to `iac/.env`, fill in the registered client credentials, and
register these exact callback URLs with the providers:

```text
https://manifold.jfa.dev/api/v1/auth/anilist/callback
https://manifold.jfa.dev/api/v1/auth/mal/callback
```

Auth routes:

```text
GET    /api/v1/auth
GET    /api/v1/auth/anilist/start
GET    /api/v1/auth/anilist
DELETE /api/v1/auth/anilist
GET    /api/v1/auth/mal/start
GET    /api/v1/auth/mal
DELETE /api/v1/auth/mal
POST   /api/v1/auth/mangadex/login
GET    /api/v1/auth/mangadex
DELETE /api/v1/auth/mangadex
POST   /api/v1/auth/anilist/token
```

`/start` and connection management require `Authorization: Bearer
<MANIFOLD_TOKEN>`. The callback is intentionally unauthenticated but is
accepted only when its one-time, expiring OAuth state matches the Durable
Object record.

`GET /v1/auth/{anilist|mal}/start` returns a 302 to the provider by default.
Clients that send `Accept: application/json` receive `{ provider, authorizationUrl }`
instead. An optional `?return=/admin/...` path is stored on the OAuth session;
after MAL callback the browser is redirected there with
`?oauth=connected|denied&provider=...`.

AniList blocks Cloudflare Worker IPs on the token endpoint (403). Admin/tracker
use the same implicit client as Paperback (`49218`): authorize URL is
`client_id=49218&response_type=token` only (AniList docs / OAuthButtonRow). The
app's registered redirect is `https://manifold.jfa.dev/admin/api/anilist/callback`,
where the browser reads `#access_token=` and POSTs
`/v1/auth/anilist/token`. Confidential client `49060` is code-flow only and
rejects `response_type=token` (`unsupported_grant_type`). Pin URL only works if
the app's registered redirect is exactly `https://anilist.co/api/v2/oauth/pin`.

MangaDex login uses the credentials in `iac/.env` only when this authenticated
endpoint is called:

```sh
curl -X POST https://manifold.jfa.dev/api/v1/auth/mangadex/login \
  -H "Authorization: Bearer $MANIFOLD_TOKEN"
```

The username and password are deployment secrets and are not stored in the
Durable Object. Only the encrypted MangaDex access and refresh tokens are
persisted.

To provision MangaDex, sign in at `https://mangadex.org/settings`, request a
personal API client, wait until it is approved/active, and copy its client ID
and secret into the four `MANGADEX_*` variables in `iac/.env`. MangaDex has no
callback URL to register for this flow.

## Commands

```sh
bun install
bun run typecheck
bun run test:oauth
bun run test
bun run plan
bun run deploy
```

Run those commands from the repository root. Tests are deploy-free. Review the
Alchemy plan before deploying the single production stack.

Set the variables in `iac/.env` before deploying. The Worker rejects requests
without `MANIFOLD_TOKEN`; `OAUTH_TOKEN_ENCRYPTION_SECRET` is used to
encrypt upstream tokens before they enter Durable Object storage.

## API

```text
GET  /api/health
GET  /api/v1/canonical/search?q=<title>&provider=all|anilist|mal&limit=1..25
GET  /api/v1/entries
POST /api/v1/entries
GET  /api/v1/entries/:entryId
POST /api/v1/entries/:entryId/providers
GET  /api/v1/entries/:entryId/progress
POST /api/v1/entries/:entryId/read
```

Canonical search returns the normalized result shape from
`@manifold/canonical`, with stable IDs such as `anilist:123` and `mal:456`,
aliases, cover/series metadata, and cross-provider IDs where the source
provides them. The response contains both `providers` (including partial
errors) and a flattened `results` array. The endpoint is authenticated with
the personal bearer token.
