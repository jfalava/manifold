/** @effect-diagnostics asyncFunction:off */
import { describe, expect, it } from "vitest";
import {
  chooseMangaDexMatch,
  embedMangaTitles,
  normalizeTitle,
  rankEmbeddedCandidates,
  type MangaDexMatchInput,
} from "../src/mangadex-match";
import type { MangaDexManga } from "@manifold/mangadex";

const entry = (overrides: Partial<MangaDexMatchInput> = {}): MangaDexMatchInput => ({
  id: "anilist:30013",
  provider: "anilist",
  providerId: "30013",
  title: "One Piece",
  aliases: ["ワンピース"],
  ...overrides,
});

const manga = (overrides: Partial<MangaDexManga> = {}): MangaDexManga => ({
  id: "manga-1",
  title: "One Piece",
  altTitles: ["ワンピース"],
  ...overrides,
});

describe("MangaDex match selection", () => {
  it("normalizes punctuation and Unicode compatibility forms without fuzzy matching", () => {
    expect(normalizeTitle("  Fullmetal—Alchemist！ ")).toBe("fullmetal alchemist");
    expect(normalizeTitle("Ｆｕｌｌｍｅｔａｌ　Ａｌｃｈｅｍｉｓｔ")).toBe("fullmetal alchemist");
  });

  it("trusts MangaDex's AniList cross-link over semantic scores", () => {
    const result = chooseMangaDexMatch(entry(), [
      { manga: manga({ id: "manga-wrong", title: "One Piece: Episode A" }), score: 0.99 },
      { manga: manga({ anilistId: "30013" }), score: 0.42 },
    ]);

    expect(result).toMatchObject({
      status: "matched",
      externalId: "manga-1",
      method: "anilist-link",
    });
  });

  it("accepts one exact title candidate without a fuzzy threshold", () => {
    const result = chooseMangaDexMatch(entry({ title: "Berserk", aliases: [] }), [
      { manga: manga({ id: "berserk", title: "Berserk", altTitles: [] }), score: 0.51 },
    ]);

    expect(result).toMatchObject({
      status: "matched",
      externalId: "berserk",
      method: "exact-title",
    });
  });

  it("keeps a close semantic tie unresolved", () => {
    const result = chooseMangaDexMatch(entry({ title: "One Piece Special", aliases: [] }), [
      {
        manga: manga({ id: "manga-1", title: "One Piece Special Edition", altTitles: [] }),
        score: 0.88,
      },
      {
        manga: manga({ id: "manga-2", title: "One Piece Special Edition", altTitles: [] }),
        score: 0.84,
      },
    ]);

    expect(result.status).toBe("ambiguous");
    expect(result.externalId).toBeUndefined();
  });

  it("rejects a mid-band semantic hit that the old 0.78/0.04 bar would have accepted", () => {
    const result = chooseMangaDexMatch(entry({ title: "One Piece Special", aliases: [] }), [
      {
        manga: manga({ id: "manga-1", title: "One Piece Special Edition", altTitles: [] }),
        score: 0.8,
      },
      { manga: manga({ id: "manga-2", title: "Unrelated", altTitles: [] }), score: 0.74 },
    ]);

    expect(result.status).toBe("ambiguous");
    expect(result.externalId).toBeUndefined();
  });

  it("accepts a clear high-confidence semantic winner", () => {
    const result = chooseMangaDexMatch(entry({ title: "One Piece Special", aliases: [] }), [
      {
        manga: manga({ id: "manga-1", title: "One Piece Special Edition", altTitles: [] }),
        score: 0.91,
      },
      { manga: manga({ id: "manga-2", title: "Unrelated", altTitles: [] }), score: 0.8 },
    ]);

    expect(result).toMatchObject({
      status: "matched",
      externalId: "manga-1",
      method: "vectorize",
    });
  });

  it("ranks fresh candidates with the same cosine similarity used by Vectorize", () => {
    const result = rankEmbeddedCandidates(
      [1, 0],
      [
        { manga: manga({ id: "near" }), embedding: [0.9, 0.1] },
        { manga: manga({ id: "far" }), embedding: [0, 1] },
      ],
    );

    expect(result[0]?.manga.id).toBe("near");
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
  });

  it("embeds batches four at a time and returns the vectors in input order", async () => {
    const texts = Array.from({ length: 100 }, (_, index) => String(index));
    let inFlight = 0;
    let peak = 0;
    let calls = 0;

    const vectors = await embedMangaTitles(
      {
        run: async (_model, inputs) => {
          const chunk = [inputs.text].flat();
          calls += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);

          // Earlier batches take longer, so a result ordered by completion
          // instead of by input would come back shuffled.
          for (let tick = 0; tick < 20 - calls * 2; tick += 1) {
            await Promise.resolve();
          }

          inFlight -= 1;

          return { data: chunk.map((text) => [Number(text) + 1]) };
        },
      },
      texts,
    );

    expect(calls).toBe(7);
    expect(peak).toBe(4);
    expect(vectors).toEqual(texts.map((text) => [Number(text) + 1]));
  });
});
