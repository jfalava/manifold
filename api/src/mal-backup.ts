import { platformFetch } from "./effect-host";
import { Effect, Schema } from "effect";
import { MalBackupIdentity, type ListStatus, type RegistryEntry } from "@manifold/contract";
import type { CanonicalSearchResult, CanonicalSearchSource } from "@manifold/canonical";
import { createMyAnimeListSource } from "@manifold/canonical/sources";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import {
  cosineSimilarity,
  embedMangaTitles,
  normalizeTitle,
  VECTOR_ACCEPT_MARGIN,
  VECTOR_ACCEPT_SCORE,
} from "./mangadex-match";
import type { Env } from "./types";

export const MalBackupPayload = Schema.Struct({
  entryId: Schema.NonEmptyString,
  backupIdentity: Schema.optional(MalBackupIdentity),
});

export interface MalMatch {
  readonly externalId: string;
  readonly title?: string;
  readonly method: "binding" | "anilist-id" | "title" | "semantic";
}

export interface RankedMalCandidate {
  readonly entry: CanonicalSearchResult;
  readonly score: number;
}

const uniqueTitles = (titles: readonly string[]): string[] => {
  const values = new Map<string, string>();
  for (const title of titles) {
    const key = normalizeTitle(title);
    if (key && !values.has(key)) {
      values.set(key, title.trim());
    }
  }
  return [...values.values()];
};

export const chooseMalMatch = (
  titles: readonly string[],
  candidates: readonly RankedMalCandidate[],
): MalMatch | undefined => {
  const normalized = new Set(uniqueTitles(titles).map(normalizeTitle));
  const exact = candidates.filter(({ entry }) =>
    uniqueTitles([entry.title, ...entry.aliases]).some((title) =>
      normalized.has(normalizeTitle(title)),
    ),
  );
  // Conflicting exact matches must not be broken by semantic ranking.
  if (exact.length > 1) {
    return undefined;
  }
  const ordered = [...candidates].sort((left, right) => right.score - left.score);
  const best = exact[0] ?? ordered[0];
  if (!best) {
    return undefined;
  }
  const margin = ordered[1] === undefined ? 1 : best.score - ordered[1].score;
  if (
    exact.length === 0 &&
    !(best.score >= VECTOR_ACCEPT_SCORE && margin >= VECTOR_ACCEPT_MARGIN)
  ) {
    return undefined;
  }
  return {
    externalId: best.entry.providerId,
    title: best.entry.title,
    method: exact.length === 1 ? "title" : "semantic",
  };
};

const embeddingText = (titles: readonly string[]): string =>
  ["manga title", ...uniqueTitles(titles)].join("\n");

export const resolveMalBackup = (
  env: Pick<Env, "AI" | "MANIFOLD_MAL_CLIENT_ID">,
  entry: RegistryEntry,
  identity?: MalBackupIdentity,
  source: CanonicalSearchSource = createMyAnimeListSource({
    clientId: env.MANIFOLD_MAL_CLIENT_ID,
    userAgent: manifoldUserAgent("api"),
    fetcher: (input, init) =>
      platformFetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  }),
): Promise<MalMatch> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const binding = entry.providers.find((link) => link.provider === "mal");
      if (binding) {
        return { externalId: binding.externalId, title: binding.title, method: "binding" as const };
      }
      const anilistId = entry.providers.find((link) => link.provider === "anilist")?.externalId;
      // An identity attached to another AniList title must never influence this entry.
      const observed = identity?.anilistId === anilistId ? identity : undefined;
      if (observed?.malId) {
        if (!/^[1-9]\d*$/.test(observed.malId)) {
          return yield* Effect.fail(new Error("Invalid AniList MAL cross-link"));
        }
        return { externalId: observed.malId, method: "anilist-id" as const };
      }
      const titles = uniqueTitles([
        entry.title,
        ...entry.providers.flatMap((link) => (link.title ? [link.title] : [])),
        ...(observed?.titles ?? []),
      ]);
      const candidates = new Map<string, CanonicalSearchResult>();
      // Search every title variant sequentially. Do not accept a partial search if
      // one request fails: the missing response may contain a competing match.
      for (const title of titles) {
        const found = yield* source.search(title, { limit: 25 });
        for (const candidate of found) {
          candidates.set(candidate.providerId, candidate);
        }
      }
      const entries = [...candidates.values()];
      const exact = chooseMalMatch(
        titles,
        entries.map((candidate) => ({ entry: candidate, score: 0 })),
      );
      if (exact) {
        return exact;
      }
      if (entries.length === 0) {
        return yield* Effect.fail(new Error("MAL backup unmatched: no candidates"));
      }
      const vectors = yield* Effect.tryPromise({
        try: () =>
          embedMangaTitles(env.AI, [
            embeddingText(titles),
            ...entries.map((candidate) => embeddingText([candidate.title, ...candidate.aliases])),
          ]),
        catch: (cause) => (cause instanceof Error ? cause : new Error(errorMessage(cause))),
      });
      const query = vectors[0] ?? [];
      const match = chooseMalMatch(
        titles,
        entries.map((candidate, index) => ({
          entry: candidate,
          score: cosineSimilarity(query, vectors[index + 1] ?? []),
        })),
      );
      if (!match) {
        return yield* Effect.fail(new Error("MAL backup ambiguous: no unique confident match"));
      }
      return match;
    }),
  );

/** Only status is projected; MAL scores, notes, progress, and deletions are untouched. */
export const writeMalBackupStatus = (
  externalId: string,
  status: ListStatus,
  accessToken: string,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!/^[1-9]\d*$/.test(externalId)) {
        return yield* Effect.fail(new Error("Invalid MAL manga id"));
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          platformFetch(`https://api.myanimelist.net/v2/manga/${externalId}/my_list_status`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": manifoldUserAgent("api"),
            },
            body: new URLSearchParams({
              status: status === "re_reading" ? "reading" : status,
              is_rereading: String(status === "re_reading"),
            }),
            signal: AbortSignal.timeout(15_000),
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(errorMessage(cause))),
      });
      if (!response.ok) {
        return yield* Effect.fail(new Error(`MAL backup status failed: HTTP ${response.status}`));
      }
    }),
  );
