import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  createAniListSource,
  createMyAnimeListSource,
} from "../src/sources";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("AniList canonical source", () => {
  it("searches manga and normalizes stable ids, aliases, metadata, and external links", async () => {
    let requestBody: unknown;
    const source = createAniListSource({
      fetcher: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return jsonResponse({
          data: {
            Page: {
              media: [
                {
                  id: 123,
                  idMal: 456,
                  title: {
                    romaji: "One Piece",
                    english: "One Piece",
                    native: "ワンピース",
                    userPreferred: "One Piece",
                  },
                  synonyms: ["OP"],
                  description: "A pirate adventure.",
                  startDate: { year: 1997, month: 7, day: 22 },
                  chapters: 1170,
                  volumes: 110,
                  status: "RELEASING",
                  averageScore: 88,
                  coverImage: { large: "https://example.test/cover.jpg" },
                  externalLinks: [{ site: "MangaDex", url: "https://mangadex.org/title/01234567-89ab-cdef-0123-456789abcdef" }],
                },
              ],
            },
          },
        });
      },
    });

    const results = await Effect.runPromise(source.search("One Piece", { limit: 5 }));
    const result = results[0];

    expect(requestBody).toMatchObject({ variables: { search: "One Piece", page: 1, perPage: 5 } });
    expect(result).toMatchObject({
      id: "anilist:123",
      provider: "anilist",
      providerId: "123",
      title: "One Piece",
      externalIds: { anilist: "123", mal: "456", mangadex: "01234567-89ab-cdef-0123-456789abcdef" },
      score: 0.88,
      metadata: {
        chapters: 1170,
        volumes: 110,
        startDate: "1997-07-22",
        coverUrl: "https://example.test/cover.jpg",
      },
    });
    expect(result?.aliases).toEqual(["One Piece", "ワンピース", "OP"]);
  });

  it("maps a single manga lookup to the same canonical shape", async () => {
    const source = createAniListSource({
      fetcher: async () =>
        jsonResponse({
          data: {
            Media: {
              id: 42,
              title: { romaji: "Example" },
              synonyms: [],
            },
          },
        }),
    });

    const result = await Effect.runPromise(source.getById("42"));
    expect(result?.id).toBe("anilist:42");
    expect(result?.externalIds).toEqual({ anilist: "42" });
  });

  it("includes upstream diagnostics when AniList rejects a request", async () => {
    const source = createAniListSource({
      fetcher: async () =>
        jsonResponse(
          {
            errors: [{ message: "You have been manually blocked", status: 403 }],
          },
          403,
        ),
    });

    await expect(Effect.runPromise(source.search("One"))).rejects.toMatchObject({
      _tag: "CanonicalSourceError",
      provider: "anilist",
      status: 403,
      message: expect.stringContaining("You have been manually blocked"),
    });
  });
});

describe("MyAnimeList canonical source", () => {
  it("uses the client id header and normalizes REST search results", async () => {
    let requestUrl: URL | undefined;
    let requestHeaders: Headers | undefined;
    const source = createMyAnimeListSource({
      clientId: "mal-client",
      fetcher: async (input, init) => {
        requestUrl = new URL(input.toString());
        requestHeaders = new Headers(init?.headers);
        return jsonResponse({
          data: [
            {
              node: {
                id: 77,
                title: "Example Manga",
                alternative_titles: {
                  en: "Example Manga",
                  ja: "例の漫画",
                  synonyms: ["Example"],
                },
                synopsis: "An example.",
                num_chapters: 10,
                num_volumes: 2,
                start_date: "2020-01-02",
                status: "finished",
                mean: 8.5,
                main_picture: { medium: "https://example.test/mal.jpg" },
              },
            },
          ],
        });
      },
    });

    const results = await Effect.runPromise(source.search("Example", { limit: 7 }));
    expect(requestUrl?.searchParams.get("q")).toBe("Example");
    expect(requestUrl?.searchParams.get("limit")).toBe("7");
    expect(requestHeaders?.get("X-MAL-CLIENT-ID")).toBe("mal-client");
    expect(results[0]).toMatchObject({
      id: "mal:77",
      title: "Example Manga",
      externalIds: { mal: "77" },
      score: 0.85,
      metadata: {
        chapters: 10,
        volumes: 2,
        startDate: "2020-01-02",
      },
    });
  });

  it("fails clearly when the client id is not configured", async () => {
    const source = createMyAnimeListSource({ clientId: "not-configured" });

    await expect(Effect.runPromise(source.search("Example"))).rejects.toMatchObject({
      _tag: "CanonicalSourceError",
      provider: "mal",
      message: "MyAnimeList client id is not configured",
    });
  });
});
