# MangaDex adapter

MangaDex API contracts and adapter code. `createMangaDexClient` uses the v5
API for title search, manga details, translated chapters, and
MangaDex@Home page resolution. Its fetcher is injectable so the personal
Worker and Paperback source can use their own request schedulers.

MangaDex is the preferred reading provider when a canonical entry has a usable
link. Access tokens are optional for public reading requests and are never
embedded in the Paperback repository bundle.
