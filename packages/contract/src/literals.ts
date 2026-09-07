import { Schema } from "effect";

export const CanonicalProvider = Schema.Literals(["anilist", "mal", "local"]);
export type CanonicalProvider = Schema.Schema.Type<typeof CanonicalProvider>;

export const ContentProvider = Schema.Literals(["mangadex", "comix"]);
export type ContentProvider = Schema.Schema.Type<typeof ContentProvider>;

/** Providers that appear in registry links. */
export const RegistryProvider = Schema.Literals(["anilist", "mal", "mangadex", "comix"]);
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

export const CanonicalSearchProviderFilter = Schema.Literals(["all", "anilist", "mal"]);
export type CanonicalSearchProviderFilter = Schema.Schema.Type<
  typeof CanonicalSearchProviderFilter
>;
