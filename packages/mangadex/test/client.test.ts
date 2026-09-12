/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { requestHref, requestInitText, type JsonValue } from "@manifold/json";
import { createMangaDexClient } from "../src/index";

const jsonResponse = (body: JsonValue, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("MangaDex client", () => {
  it("normalizes manga search and cover relationships", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          data: [
            {
              id: "manga-1",
              attributes: {
                title: { en: "Example Manga" },
                altTitles: [{ ja: "例" }],
                links: { al: "100", mal: "200" },
                description: { en: "A description" },
                status: "ongoing",
                year: 2024,
              },
              relationships: [
                {
                  type: "cover_art",
                  attributes: { fileName: "cover.jpg" },
                },
              ],
            },
          ],
        });
      },
    });

    const result = await Effect.runPromise(client.search("Example"));

    expect(result).toEqual([
      {
        id: "manga-1",
        title: "Example Manga",
        altTitles: ["例"],
        anilistId: "100",
        myAnimeListId: "200",
        description: "A description",
        coverUrl: "https://uploads.mangadex.org/covers/manga-1/cover.jpg.512.jpg",
        status: "ongoing",
        year: 2024,
      },
    ]);
    expect(requests[0]).toContain("/manga?");
    expect(requests[0]).toContain("includes%5B%5D=cover_art");
  });

  it("paginates chapters and resolves MangaDex@Home pages", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      limit: 1,
      fetcher: async (input) => {
        const url = requestHref(input);
        requests.push(url);
        if (url.includes("/at-home/server/")) {
          return jsonResponse({
            baseUrl: "https://uploads.example",
            chapter: {
              hash: "hash",
              mangaId: "manga-1",
              data: [{ filename: "page-1.jpg", width: 800, height: 1200 }],
            },
          });
        }
        const offset = new URL(url).searchParams.get("offset");
        return jsonResponse({
          total: 2,
          data: [
            {
              id: `chapter-${offset}`,
              attributes: {
                chapter: offset,
                volume: "1",
                translatedLanguage: "en",
                pages: 1,
                publishAt: "2024-01-01T00:00:00Z",
              },
              relationships: [{ type: "manga", id: "manga-1" }],
            },
          ],
        });
      },
    });

    const chapters = await Effect.runPromise(client.getChapters("manga-1"));
    const details = await Effect.runPromise(client.getChapterDetails("chapter-0"));

    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({
      id: "chapter-0",
      mangaId: "manga-1",
      chapterNumber: 0,
      volumeNumber: 1,
      pageCount: 1,
      publishedAt: Date.parse("2024-01-01T00:00:00Z"),
    });
    expect(details).toEqual({
      id: "chapter-0",
      mangaId: "manga-1",
      pages: [
        {
          url: "https://uploads.example/data/hash/page-1.jpg",
          width: 800,
          height: 1200,
        },
      ],
    });
    expect(requests.filter((url) => url.includes("/chapter?")).length).toBe(2);
    expect(requests[0]).toContain("manga=manga-1");
    expect(requests[0]).not.toContain("manga%5B%5D=manga-1");
  });

  it("preserves upstream status in a typed source error", async () => {
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async () => jsonResponse({ error: "missing" }, 404),
    });

    await expect(Effect.runPromise(client.getManga("missing"))).rejects.toMatchObject({
      _tag: "MangaDexSourceError",
      status: 404,
    });
  });

  it("marks chapters as read with the authenticated MangaDex endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      accessToken: "access-token",
      fetcher: async (input, init) => {
        requests.push({ url: requestHref(input), init });
        return new Response(null, { status: 204 });
      },
    });

    await Effect.runPromise(client.markChaptersRead("manga-1", ["chapter-1", "chapter-2"]));

    expect(requests[0]?.url).toBe("https://mangadex.test/manga/manga-1/read");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer access-token",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(requestInitText(requests[0]?.init) ?? "null")).toEqual({
      chapterIdsRead: ["chapter-1", "chapter-2"],
    });
  });

  it("lists manga with ids, ordering, and recency filters", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: 1,
          data: [{ id: "manga-9", attributes: { title: { en: "Nine" } } }],
        });
      },
    });

    const result = await Effect.runPromise(
      client.listManga({
        ids: ["a", "b"],
        orderKey: "followedCount",
        createdAtSince: "2026-07-22T00:00:00Z",
        hasAvailableChapters: true,
        limit: 2,
        offset: 4,
      }),
    );

    expect(result.items[0]?.id).toBe("manga-9");
    const url = new URL(requests[0]);
    expect(url.searchParams.getAll("ids[]")).toEqual(["a", "b"]);
    expect(url.searchParams.get("order[followedCount]")).toBe("desc");
    expect(url.searchParams.get("createdAtSince")).toBe("2026-07-22T00:00:00Z");
    expect(url.searchParams.get("hasAvailableChapters")).toBe("true");
    expect(url.searchParams.get("offset")).toBe("4");
  });

  it("fetches the latest chapter feed ordered by readableAt", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: 1,
          data: [
            {
              id: "chapter-5",
              attributes: {
                chapter: "5",
                translatedLanguage: "en",
                readableAt: "2026-08-20T00:00:00Z",
              },
              relationships: [{ type: "manga", id: "manga-1" }],
            },
          ],
        });
      },
    });

    const result = await Effect.runPromise(client.latestChapters({ limit: 10 }));

    expect(result.items[0]?.id).toBe("chapter-5");
    expect(result.total).toBe(1);
    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/chapter");
    expect(url.searchParams.get("order[readableAt]")).toBe("desc");
  });

  it("queries the followed feed with publish cutoff and explicit content ratings", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: 1,
          data: [
            {
              id: "chapter-7",
              attributes: {
                chapter: "7",
                translatedLanguage: "en",
                publishAt: "2026-08-01T00:00:00Z",
              },
              relationships: [{ type: "manga", id: "manga-2" }],
            },
          ],
        });
      },
    });

    const result = await Effect.runPromise(
      client.followedFeed({
        publishedAtSince: "2026-01-01T00:00:00Z",
      }),
    );

    expect(result.items[0]?.id).toBe("chapter-7");
    expect(result.items[0]?.publishedAt).toBe(Date.parse("2026-08-01T00:00:00Z"));
    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/user/follows/manga/feed");
    expect(url.searchParams.get("publishAtSince")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("order[readableAt]")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.getAll("contentRating[]")).toEqual([
      "safe",
      "suggestive",
      "erotica",
      "pornographic",
    ]);
  });

  it("fetches the newest chapter since a cutoff for a single manga", async () => {
    const requests: string[] = [];
    let empty = false;
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: empty ? 0 : 1,
          data: empty
            ? []
            : [
                {
                  id: "chapter-9",
                  attributes: {
                    chapter: "9",
                    translatedLanguage: "en",
                    publishAt: "2026-08-02T00:00:00Z",
                  },
                  relationships: [{ type: "manga", id: "manga-3" }],
                },
              ],
        });
      },
    });

    const chapter = await Effect.runPromise(
      client.latestChapterSince("manga-3", "2026-01-01T00:00:00Z"),
    );
    expect(chapter?.id).toBe("chapter-9");
    expect(chapter?.publishedAt).toBe(Date.parse("2026-08-02T00:00:00Z"));
    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/manga/manga-3/feed");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("publishAtSince")).toBe("2026-01-01T00:00:00Z");

    empty = true;
    requests.length = 0;
    const none = await Effect.runPromise(
      client.latestChapterSince("manga-3", "2026-01-01T00:00:00Z"),
    );
    expect(none).toBeUndefined();
  });

  it("pages the followed manga list", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: 1,
          data: [{ id: "manga-8", attributes: { title: { en: "Eight" } } }],
        });
      },
    });

    const result = await Effect.runPromise(client.followedManga({ limit: 100, offset: 0 }));

    expect(result.items[0]?.id).toBe("manga-8");
    expect(result.total).toBe(1);
    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/user/follows/manga");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("lists manga with content rating overrides for id lookups", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({ total: 0, data: [] });
      },
    });

    await Effect.runPromise(
      client.listManga({
        ids: ["adult-1"],
        contentRating: ["safe", "suggestive", "erotica", "pornographic"],
      }),
    );

    const url = new URL(requests[0]);
    expect(url.searchParams.getAll("ids[]")).toEqual(["adult-1"]);
    expect(url.searchParams.getAll("contentRating[]")).toEqual([
      "safe",
      "suggestive",
      "erotica",
      "pornographic",
    ]);
  });

  it("retries transient 5xx and 429 responses before failing", async () => {
    let calls = 0;
    const statuses = [500, 429, 200];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      retryDelayMs: 1,
      fetcher: async () => {
        const status = statuses[Math.min(calls, statuses.length - 1)];
        calls += 1;
        if (status === 200) {
          return jsonResponse({ statuses: {} });
        }
        return new Response(null, { status, headers: { "retry-after": "0" } });
      },
    });

    const statuses1 = await Effect.runPromise(client.readingStatuses());
    expect(statuses1).toEqual({});
    expect(calls).toBe(3);
  });

  it("reads and writes reading statuses with authentication", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      accessToken: "access-token",
      fetcher: async (input, init) => {
        requests.push({ url: requestHref(input), init });
        if (requestHref(input).endsWith("/status") && init?.method === "POST") {
          return new Response(null, { status: 200 });
        }
        return jsonResponse({ statuses: { "manga-1": "reading", "manga-2": "bogus" } });
      },
    });

    const statuses = await Effect.runPromise(client.readingStatuses());
    expect(statuses).toEqual({ "manga-1": "reading" });
    expect(requests[0]?.url).toBe("https://mangadex.test/manga/status");

    await Effect.runPromise(client.readingStatuses({ status: "dropped" }));
    expect(
      requests.some(
        (request) => request.url === "https://mangadex.test/manga/status?status=dropped",
      ),
    ).toBe(true);

    await Effect.runPromise(client.updateReadingStatus("manga-1", "on_hold"));
    const write = requests.find((request) => request.init?.method === "POST");
    expect(write?.url).toBe("https://mangadex.test/manga/manga-1/status");
    expect(JSON.parse(requestInitText(write?.init) ?? "null")).toEqual({ status: "on_hold" });
  });

  it("fetches one page of a manga feed with explicit content ratings", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: 32,
          data: [
            {
              id: "ch-145",
              relationships: [{ type: "manga", id: "manga-9" }],
              attributes: {
                chapter: "145",
                volume: "none",
                translatedLanguage: "en",
                publishAt: "2026-08-01T00:00:00Z",
              },
            },
          ],
        });
      },
    });

    const page = await Effect.runPromise(client.feedChapters("manga-9", { limit: 500 }));

    expect(page.total).toBe(32);
    expect(page.items[0]?.chapterNumber).toBe(145);
    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/manga/manga-9/feed");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.getAll("contentRating[]")).toEqual([
      "safe",
      "suggestive",
      "erotica",
      "pornographic",
    ]);
    expect(url.searchParams.get("order[readableAt]")).toBe("desc");
  });

  it("bulk reads markers grouped by manga id", async () => {
    const requests: string[] = [];
    let empty = false;
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        if (empty) {
          return jsonResponse({ data: [] });
        }
        return jsonResponse({
          data: { "manga-1": ["chapter-1", "chapter-2"], "manga-2": [] },
        });
      },
    });

    const grouped = await Effect.runPromise(client.readMarkersBulk(["manga-1", "manga-2"]));
    expect(grouped).toEqual({ "manga-1": ["chapter-1", "chapter-2"], "manga-2": [] });

    // An all-empty history degrades to the ungrouped array shape — no markers.
    empty = true;
    requests.length = 0;
    const none = await Effect.runPromise(client.readMarkersBulk(["manga-3"]));
    expect(none).toEqual({});

    const url = new URL(requests[0]);
    expect(url.pathname).toBe("/manga/read");
    expect(url.searchParams.getAll("ids[]")).toEqual(["manga-3"]);
    expect(url.searchParams.get("grouped")).toBe("true");
  });

  it("defaults listManga to all content ratings so adult titles resolve", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        return jsonResponse({
          total: 1,
          data: [{ id: "adult-1", attributes: { title: { en: "Adult One" } } }],
        });
      },
    });

    await Effect.runPromise(client.listManga({ ids: ["adult-1"], limit: 100 }));

    const url = new URL(requests[0]);
    expect(url.searchParams.getAll("contentRating[]")).toEqual([
      "safe",
      "suggestive",
      "erotica",
      "pornographic",
    ]);
  });

  it("batches user ratings and omits unrated entries", async () => {
    const requests: string[] = [];
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      accessToken: "token",
      fetcher: async (input) => {
        requests.push(requestHref(input));
        const url = requestHref(input);
        if (url.includes("/rating")) {
          return jsonResponse({
            result: "ok",
            ratings: {
              "manga-1": { rating: 8, createdAt: "2024-01-01T00:00:00+00:00" },
            },
          });
        }
        return jsonResponse({ data: [] });
      },
    });

    const result = await Effect.runPromise(client.getRatings(["manga-1", "manga-2"]));

    expect(result).toEqual({
      "manga-1": { rating: 8, createdAt: "2024-01-01T00:00:00+00:00" },
    });
    expect(result["manga-2"]).toBeUndefined();

    const url = new URL(requests.find((value) => value.includes("/rating"))!);
    expect(url.pathname).toBe("/rating");
    expect(url.searchParams.getAll("manga[]")).toEqual(["manga-1", "manga-2"]);
  });

  it("handles empty rating input without calling upstream", async () => {
    let called = false;
    const client = createMangaDexClient({
      endpoint: "https://mangadex.test",
      fetcher: async () => {
        called = true;
        return jsonResponse({ result: "ok", ratings: {} });
      },
    });

    const result = await Effect.runPromise(client.getRatings([]));

    expect(result).toEqual({});
    expect(called).toBe(false);
  });
});
