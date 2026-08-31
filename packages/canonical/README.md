# Canonical sourcing

Contracts and source clients for canonical manga identity and progress. The
AniList client uses its public GraphQL API, while the MyAnimeList client uses
the v2 REST API and requires an `X-MAL-CLIENT-ID` value. Both normalize search
and lookup results into stable IDs (`anilist:<id>` and `mal:<id>`), aliases,
cross-provider IDs, and shared metadata. Provider-specific reading data stays
outside this package.

Use `createAniListSource` and `createMyAnimeListSource` from `./sources`.
Both clients accept an injectable `fetcher`, so network behavior is testable
without contacting the upstream providers.
