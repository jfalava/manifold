import { Schema } from "effect";

export const CanonicalProvider = Schema.Literals(["anilist", "mal", "local"]);

export type CanonicalProvider = Schema.Schema.Type<typeof CanonicalProvider>;

/**
 * A provider name: the Paperback source ID lowercased (MangaDex → mangadex,
 * XCOMIC → xcomic). Open on purpose: every tracked entry has an AniList or MAL
 * canonical identity, so a content source is only an observed link and any
 * installed Paperback source can record reads without a code change.
 */
const ProviderName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/));

/** Providers whose chapters Paperback reads and the registry records. */
export const ContentProvider = ProviderName;

export type ContentProvider = Schema.Schema.Type<typeof ContentProvider>;

/** Providers that appear in registry links: canonical (anilist, mal) or content. */
export const RegistryProvider = ProviderName;

export type RegistryProvider = Schema.Schema.Type<typeof RegistryProvider>;

export const ListStatus = Schema.Literals([
  "reading",
  "on_hold",
  "plan_to_read",
  "dropped",
  "re_reading",
  "completed",
]);

export type ListStatus = Schema.Schema.Type<typeof ListStatus>;

export const AuthProvider = Schema.Literals(["anilist", "mal", "mangadex"]);

export type AuthProvider = Schema.Schema.Type<typeof AuthProvider>;

export const OAuthProvider = Schema.Literals(["anilist", "mal"]);

export type OAuthProvider = Schema.Schema.Type<typeof OAuthProvider>;

export const OpTarget = Schema.Literals(["mangadex", "anilist", "mal"]);

export type OpTarget = Schema.Schema.Type<typeof OpTarget>;

export const OpKind = Schema.Literals([
  "mangadex.read",
  "mal.status",
  "anilist.status",
  "anilist.progress",
  "anilist.fields",
  "anilist.delete",
]);

export type OpKind = Schema.Schema.Type<typeof OpKind>;

export const OpOrigin = Schema.Literals(["device", "admin", "cli", "migration"]);

export type OpOrigin = Schema.Schema.Type<typeof OpOrigin>;

export const OpState = Schema.Literals(["pending", "completed", "failed", "blocked"]);

export type OpState = Schema.Schema.Type<typeof OpState>;

export const MangaDexMatchStatus = Schema.Literals(["matched", "ambiguous", "not_found"]);

export type MangaDexMatchStatus = Schema.Schema.Type<typeof MangaDexMatchStatus>;

export const MangaDexMatchMethod = Schema.Literals([
  "cached",
  "anilist-link",
  "mal-link",
  "vectorize",
]);

export type MangaDexMatchMethod = Schema.Schema.Type<typeof MangaDexMatchMethod>;

export const CanonicalSearchProviderFilter = Schema.Literals(["auto", "all", "anilist", "mal"]);

export type CanonicalSearchProviderFilter = Schema.Schema.Type<
  typeof CanonicalSearchProviderFilter
>;
