import { Effect, Schema } from "effect";
import {
  errorMessage,
  isFiniteNumber,
  isString,
} from "@manifold/json";
import {
  createMangaDexClient,
  type MangaDexManga,
} from "@manifold/mangadex";
import type { Ai, VectorizeIndex } from "@cloudflare/workers-types";
import type { Env } from "./types";

export const MANGADEX_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b" as const;

const VECTOR_TOP_K = 20;
// Prefill/CLI now pass AniList english/romaji/native/synonyms, so exact-title
// hits cover more cases and the semantic accept bar can sit higher.
const VECTOR_ACCEPT_SCORE = 0.85;
const VECTOR_ACCEPT_MARGIN = 0.06;
const SEARCH_TERM_LIMIT = 5;
const MATCH_CANDIDATE_LIMIT = 100;

/**
 * Vectorize metadata bag for MangaDex title embeddings.
 * Index signature matches VectorizeVector.metadata value contract.
 */
interface VectorMetadata {
  [key: string]: string | number | boolean | string[];
}

export const MangaDexMatchInput = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: Schema.Literals(["anilist", "mal"]),
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  persistSearchResults: Schema.optional(Schema.Boolean),
  externalIds: Schema.optional(
    Schema.Struct({
      anilist: Schema.optional(Schema.NonEmptyString),
      mal: Schema.optional(Schema.NonEmptyString),
      mangadex: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  metadata: Schema.optional(
    Schema.Struct({
      chapters: Schema.optional(Schema.Number),
      volumes: Schema.optional(Schema.Number),
      startDate: Schema.optional(Schema.String),
      endDate: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    }),
  ),
});

export type MangaDexMatchInput = Schema.Schema.Type<typeof MangaDexMatchInput>;

export type MangaDexMatchMethod =
  | "cached"
  | "anilist-link"
  | "mal-link"
  | "vectorize";

export interface MangaDexMatchCandidate {
  readonly externalId: string;
  readonly title: string;
  readonly score: number;
  readonly anilistId?: string;
  readonly myAnimeListId?: string;
}

export interface MangaDexMatchResult {
  readonly canonicalId: string;
  readonly status: "matched" | "ambiguous" | "not_found";
  readonly candidates: readonly MangaDexMatchCandidate[];
  readonly externalId?: string;
  readonly title?: string;
  readonly method?: MangaDexMatchMethod;
  readonly score?: number;
  readonly margin?: number;
}

export interface EmbeddedMangaDexCandidate {
  readonly manga: MangaDexManga;
  readonly embedding: readonly number[];
}

export interface RankedMangaDexCandidate {
  readonly manga: MangaDexManga;
  readonly score: number;
}

const stringValue = (value: VectorMetadata[string] | undefined): string | undefined =>
  isString(value) && value.trim().length > 0 ? value.trim() : undefined;

const numberValue = (value: VectorMetadata[string] | undefined): number | undefined => {
  if (isFiniteNumber(value)) {return value;}
  if (!isString(value) || value.trim().length === 0) {return undefined;}
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const stringArray = (value: VectorMetadata[string] | undefined): readonly string[] => {
  if (!Array.isArray(value)) {return [];}
  return value.flatMap((item) => {
    const result = isString(item) && item.trim().length > 0 ? item.trim() : undefined;
    return result ? [result] : [];
  });
};

const uniqueStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {continue;}
    const key = normalizeTitle(normalized);
    if (!key || seen.has(key)) {continue;}
    seen.add(key);
    result.push(normalized);
  }
  return result;
};

export const normalizeTitle = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const yearFromDate = (value: string | undefined): number | undefined => {
  const year = value?.slice(0, 4);
  if (!year || !/^\d{4}$/.test(year)) {return undefined;}
  return Number(year);
};

const canonicalTitles = (entry: MangaDexMatchInput): readonly string[] =>
  uniqueStrings([entry.title, ...entry.aliases]);

const mangaTitles = (manga: MangaDexManga): readonly string[] =>
  uniqueStrings([manga.title, ...manga.altTitles]);

export const buildCanonicalEmbeddingText = (entry: MangaDexMatchInput): string => {
  const year = yearFromDate(entry.metadata?.startDate);
  return [
    "manga title",
    ...canonicalTitles(entry),
    year === undefined ? undefined : `publication year ${year}`,
    entry.metadata?.status ? `status ${entry.metadata.status}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
};

export const buildMangaDexEmbeddingText = (manga: MangaDexManga): string =>
  [
    "manga title",
    ...mangaTitles(manga),
    manga.year === undefined ? undefined : `publication year ${manga.year}`,
    manga.status ? `status ${manga.status}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");

const hasExactTitle = (entry: MangaDexMatchInput, manga: MangaDexManga): boolean => {
  const canonical = new Set(canonicalTitles(entry).map(normalizeTitle));
  return mangaTitles(manga).some((title) => canonical.has(normalizeTitle(title)));
};

const linkedProviderId = (
  entry: MangaDexMatchInput,
  manga: MangaDexManga,
): string | undefined =>
  entry.provider === "anilist" ? manga.anilistId : manga.myAnimeListId;

const decisionCandidate = (
  candidate: RankedMangaDexCandidate,
): MangaDexMatchCandidate => ({
  externalId: candidate.manga.id,
  title: candidate.manga.title,
  score: Number(candidate.score.toFixed(6)),
  ...(candidate.manga.anilistId && { anilistId: candidate.manga.anilistId }),
  ...(candidate.manga.myAnimeListId && { myAnimeListId: candidate.manga.myAnimeListId }),
});

const resultForCandidates = (
  canonicalId: string,
  status: MangaDexMatchResult["status"],
  candidates: readonly RankedMangaDexCandidate[],
): MangaDexMatchResult => ({
  canonicalId,
  status,
  candidates: candidates.slice(0, 5).map(decisionCandidate),
});

export const chooseMangaDexMatch = (
  entry: MangaDexMatchInput,
  candidates: readonly RankedMangaDexCandidate[],
): MangaDexMatchResult => {
  const ordered = [...candidates].sort((left, right) => right.score - left.score);
  const exactLinks = ordered.filter(
    (candidate) => linkedProviderId(entry, candidate.manga) === entry.providerId,
  );

  if (exactLinks.length === 1) {
    const candidate = exactLinks[0];
    return {
      canonicalId: entry.id,
      status: "matched",
      candidates: [decisionCandidate(candidate)],
      externalId: candidate.manga.id,
      title: candidate.manga.title,
      method: entry.provider === "anilist" ? "anilist-link" : "mal-link",
      score: Number(candidate.score.toFixed(6)),
      margin: 1,
    };
  }

  if (exactLinks.length > 1) {
    return resultForCandidates(entry.id, "ambiguous", exactLinks);
  }

  const exactTitles = ordered.filter((candidate) => hasExactTitle(entry, candidate.manga));
  if (exactTitles.length === 1) {
    const candidate = exactTitles[0];
    return {
      canonicalId: entry.id,
      status: "matched",
      candidates: [decisionCandidate(candidate)],
      externalId: candidate.manga.id,
      title: candidate.manga.title,
      method: "vectorize",
      score: Number(candidate.score.toFixed(6)),
      margin: 1,
    };
  }

  const best = ordered[0];
  if (!best) {return resultForCandidates(entry.id, "not_found", ordered);}

  const second = ordered[1];
  const margin = second === undefined ? 1 : best.score - second.score;
  if (best.score >= VECTOR_ACCEPT_SCORE && margin >= VECTOR_ACCEPT_MARGIN) {
    return {
      canonicalId: entry.id,
      status: "matched",
      candidates: ordered.slice(0, 5).map(decisionCandidate),
      externalId: best.manga.id,
      title: best.manga.title,
      method: "vectorize",
      score: Number(best.score.toFixed(6)),
      margin: Number(margin.toFixed(6)),
    };
  }

  return resultForCandidates(entry.id, "ambiguous", ordered);
};

export const cosineSimilarity = (
  left: readonly number[],
  right: readonly number[],
): number => {
  if (left.length === 0 || left.length !== right.length) {return 0;}
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {return 0;}
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
};

export const rankEmbeddedCandidates = (
  query: readonly number[],
  candidates: readonly EmbeddedMangaDexCandidate[],
): readonly RankedMangaDexCandidate[] =>
  candidates
    .map((candidate) => ({
      manga: candidate.manga,
      score: cosineSimilarity(query, candidate.embedding),
    }))
    .sort((left, right) => right.score - left.score);

const vectorCandidate = (
  id: string,
  metadata: VectorMetadata | undefined,
): MangaDexManga | undefined => {
  const mangaId = stringValue(metadata?.mangaId) ?? id.replace(/^mangadex:/, "");
  const title = stringValue(metadata?.title);
  if (!mangaId || !title) {return undefined;}
  const year = numberValue(metadata?.year);
  return {
    id: mangaId,
    title,
    altTitles: stringArray(metadata?.aliases),
    ...(stringValue(metadata?.anilistId) && { anilistId: stringValue(metadata?.anilistId) }),
    ...(stringValue(metadata?.malId) && { myAnimeListId: stringValue(metadata?.malId) }),
    ...(!(year === undefined) && { year }),
  };
};

const vectorMetadata = (manga: MangaDexManga): VectorMetadata => {
  const metadata: VectorMetadata = {};
  metadata.provider = "mangadex";
  metadata.mangaId = manga.id;
  metadata.title = manga.title;
  metadata.aliases = [...manga.altTitles];
  if (manga.anilistId) {metadata.anilistId = manga.anilistId;}
  if (manga.myAnimeListId) {metadata.malId = manga.myAnimeListId;}
  if (manga.year !== undefined) {metadata.year = manga.year;}
  return metadata;
};

const uniqueManga = (values: readonly MangaDexManga[]): MangaDexManga[] => {
  const seen = new Set<string>();
  const result: MangaDexManga[] = [];
  for (const manga of values) {
    if (seen.has(manga.id)) {continue;}
    seen.add(manga.id);
    result.push(manga);
  }
  return result;
};

// Workers AI caps per-request input size ("3030: input too big") somewhere
// below a hundred titles, so candidate embeddings go out in small batches.
const EMBED_BATCH_SIZE = 16;

const embed = async (ai: Ai, texts: readonly string[]): Promise<readonly number[][]> => {
  if (texts.length === 0) {return [];}
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += EMBED_BATCH_SIZE) {
    const chunk = [...texts].slice(index, index + EMBED_BATCH_SIZE);
    const result = await ai.run(MANGADEX_EMBEDDING_MODEL, { text: chunk });
    const data = result.data ?? [];
    if (data.length !== chunk.length || data.some((vector) => vector.length === 0)) {
      throw new Error("Workers AI returned an invalid MangaDex embedding response");
    }
    vectors.push(...data);
  }
  return vectors;
};

const indexedCandidates = (
  matches: Awaited<ReturnType<VectorizeIndex["query"]>>["matches"],
): readonly RankedMangaDexCandidate[] =>
  matches.flatMap((match) => {
    // SAFETY: optional field is VectorMetadata | undefined when present at this call site
    const manga = vectorCandidate(match.id, match.metadata as VectorMetadata | undefined);
    return manga ? [{ manga, score: match.score }] : [];
  });

const queryIndex = async (
  index: VectorizeIndex,
  vector: readonly number[],
  entry: MangaDexMatchInput,
): Promise<readonly RankedMangaDexCandidate[]> => {
  try {
    const exact = await index.query([...vector], {
      topK: 1,
      filter: entry.provider === "anilist"
        ? { anilistId: entry.providerId }
        : { malId: entry.providerId },
      returnMetadata: "all",
    });
    const exactCandidates = indexedCandidates(exact.matches);
    if (exactCandidates.length > 0) {return exactCandidates;}
  } catch (error) {
    console.warn(`[MangaDexMatch] exact Vectorize lookup failed: ${errorMessage(error)}`);
  }

  try {
    const matches = await index.query([...vector], {
      topK: VECTOR_TOP_K,
      returnMetadata: "all",
    });
    return indexedCandidates(matches.matches);
  } catch (error) {
    console.warn(`[MangaDexMatch] Vectorize lookup failed: ${errorMessage(error)}`);
    return [];
  }
};

const searchMangaDex = async (
  entry: MangaDexMatchInput,
): Promise<readonly MangaDexManga[]> => {
  const client = createMangaDexClient({ limit: MATCH_CANDIDATE_LIMIT });
  const terms = uniqueStrings([entry.title, ...entry.aliases]).slice(0, SEARCH_TERM_LIMIT);
  // Sequential on purpose: parallel searches burst api.mangadex.org from
  // shared Cloudflare egress IPs and trip its 403 anomaly blocking — the same
  // reason AniList Worker egress is blocked. Slower per resolve, but every
  // term actually gets answered.
  const searched: MangaDexManga[] = [];
  let lastError: unknown;
  for (const term of terms) {
    try {
      searched.push(...(await Effect.runPromise(client.search(term))));
    } catch (error) {
      lastError = error;
    }
  }
  if (searched.length === 0 && lastError !== undefined) {throw lastError;}
  return uniqueManga(searched);
};

const cachedResult = (
  entry: MangaDexMatchInput,
  externalId: string,
  title: string | undefined,
): MangaDexMatchResult => ({
  canonicalId: entry.id,
  status: "matched",
  candidates: [{ externalId, title: title ?? externalId, score: 1 }],
  externalId,
  ...(title && { title }),
  method: "cached",
  score: 1,
  margin: 1,
});

export const resolveMangaDex = async (
  env: Env,
  input: MangaDexMatchInput,
): Promise<MangaDexMatchResult> => {
  const entry = input;
  const sync = env.MANIFOLD_SYNC.getByName("default");
  const existing = await sync.getEntry(entry.id);
  const cached = existing?.providers.find((provider) => provider.provider === "mangadex");
  if (cached) {return cachedResult(entry, cached.externalId, cached.title);}

  if (entry.externalIds?.mangadex) {
    return cachedResult(entry, entry.externalIds.mangadex, undefined);
  }

  const queryVector = (await embed(env.AI, [buildCanonicalEmbeddingText(entry)]))[0];
  if (!queryVector) {throw new Error("Workers AI returned no MangaDex query embedding");}

  const indexed = await queryIndex(env.MANGADEX_INDEX, queryVector, entry);
  const indexedDecision = chooseMangaDexMatch(entry, indexed);
  if (indexedDecision.status === "matched") {return indexedDecision;}

  const searched = await searchMangaDex(entry);
  const fresh = await embed(env.AI, searched.map(buildMangaDexEmbeddingText));
  const freshRanked = rankEmbeddedCandidates(
    queryVector,
    searched.map((manga, index) => ({ manga, embedding: fresh[index] ?? [] })),
  );

  if (input.persistSearchResults !== false) {
    try {
      await env.MANGADEX_INDEX.upsert(
        searched.flatMap((manga, index) => {
          const values = fresh[index];
          return values
            ? [{ id: `mangadex:${manga.id}`, values, metadata: vectorMetadata(manga) }]
            : [];
        }),
      );
    } catch (error) {
      console.warn(`[MangaDexMatch] Vectorize upsert failed: ${errorMessage(error)}`);
    }
  }

  const byId = new Map<string, RankedMangaDexCandidate>();
  for (const candidate of indexed) {byId.set(candidate.manga.id, candidate);}
  for (const candidate of freshRanked) {
    const existingCandidate = byId.get(candidate.manga.id);
    if (!existingCandidate || candidate.score > existingCandidate.score) {
      byId.set(candidate.manga.id, candidate);
    }
  }
  return chooseMangaDexMatch(entry, [...byId.values()]);
};
