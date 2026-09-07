import { ContentRating, type SearchResultItem } from "@paperback/types";
import type { CanonicalSearchResult } from "@manifold/canonical";
import { safeImageUrl } from "./image-url.js";

export const toCanonicalSearchResult = (
  entry: CanonicalSearchResult,
): SearchResultItem => ({
  mangaId: entry.id,
  title: entry.title,
  subtitle: entry.aliases.filter((title) => title !== entry.title).join(" · ") || undefined,
  imageUrl: safeImageUrl(entry.metadata?.coverUrl),
  contentRating: ContentRating.EVERYONE,
  metadata: entry,
});
