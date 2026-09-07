import type { CanonicalEntry, CanonicalSearchResult } from "@manifold/canonical";
import type { PersonalEntry } from "@manifold/paperback-runtime";

type RegistryDetailsEntry = Pick<
  PersonalEntry,
  "id" | "provider" | "providerId" | "title" | "providers"
>;

/** Keep the registry UUID while enriching its display metadata from a provider. */
export const canonicalResultForRegistryEntry = (
  entry: RegistryDetailsEntry,
  hydrated: CanonicalEntry | undefined,
): CanonicalSearchResult => {
  if (hydrated) {
    return { ...hydrated, id: entry.id, score: 0 };
  }

  const anilist = entry.providers.find((provider) => provider.provider === "anilist");
  const mal = entry.providers.find((provider) => provider.provider === "mal");
  return {
    id: entry.id,
    provider: anilist ? "anilist" : mal ? "mal" : entry.provider,
    providerId: anilist?.externalId ?? mal?.externalId ?? entry.providerId,
    title: entry.title,
    aliases: [],
    score: 0,
  };
};
