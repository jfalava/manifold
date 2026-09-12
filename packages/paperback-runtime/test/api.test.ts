/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
import { describe, expect, it } from "vitest";
import { createPersonalApiClient, PersonalApiError, type PersonalApiResponse } from "../src/api";

describe("Paperback personal API client", () => {
  it("adds the secure bearer token and normalizes canonical search", async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const client = createPersonalApiClient(
      async (request) => {
        requests.push(request);
        return {
          status: 200,
          body: {
            query: "Example",
            results: [
              {
                id: "anilist:1",
                provider: "anilist",
                providerId: "1",
                title: "Example",
                aliases: ["Example"],
                score: 1,
              },
            ],
            providers: [
              {
                provider: "anilist",
                results: [
                  {
                    id: "anilist:1",
                    provider: "anilist",
                    providerId: "1",
                    title: "Example",
                    aliases: ["Example"],
                    score: 1,
                  },
                ],
              },
            ],
          },
        };
      },
      { origin: "https://personal.test/", token: "secret" },
    );

    const result = await client.searchCanonical(" One Piece & Co ", 50);

    expect(result.results[0]?.id).toBe("anilist:1");
    expect(requests[0]).toMatchObject({
      url: "https://personal.test/v1/canonical/search?q=One%20Piece%20%26%20Co&provider=auto&limit=25",
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });
  });

  it("loads registry metadata with its UUID and MAL provenance", async () => {
    const client = createPersonalApiClient(
      async (request) => {
        expect(request.url).toBe("https://personal.test/v1/entries/entry-42/canonical");
        return {
          status: 200,
          body: {
            id: "entry-42",
            provider: "mal",
            providerId: "77",
            title: "MAL title",
            aliases: ["Alias"],
            metadata: { coverUrl: "https://example.test/mal.jpg" },
          },
        };
      },
      { origin: "https://personal.test", token: "secret" },
    );
    expect(await client.getRegistryCanonical("entry-42")).toMatchObject({
      id: "entry-42",
      provider: "mal",
      providerId: "77",
      aliases: ["Alias"],
      metadata: { coverUrl: "https://example.test/mal.jpg" },
    });
  });

  it("reports both providers' failures instead of a bare gateway status", async () => {
    const client = createPersonalApiClient(
      async () => ({
        status: 502,
        body: {
          query: "ab",
          results: [],
          providers: [
            {
              provider: "anilist",
              results: [],
              error: { message: "AniList blocked", status: 403 },
            },
            {
              provider: "mal",
              results: [],
              error: { message: "MyAnimeList search requires at least 3 characters", status: 400 },
            },
          ],
        },
      }),
      { token: "secret" },
    );
    await expect(client.searchCanonical("ab")).rejects.toEqual(
      new PersonalApiError({ message: "AniList blocked; MyAnimeList search requires at least 3 characters", status: 502 }),
    );
  });

  it("turns a missing entry into undefined and preserves other errors", async () => {
    let calls = 0;
    const client = createPersonalApiClient(
      async () => {
        calls += 1;
        return { status: calls === 1 ? 404 : 502, body: { error: "upstream unavailable" } };
      },
      { token: "secret" },
    );

    await expect(client.getEntry("anilist:1")).resolves.toBeUndefined();
    await expect(client.getEntry("anilist:1")).rejects.toEqual(
      new PersonalApiError({ message: "upstream unavailable", status: 502 }),
    );
  });

  it("searches, lists, and ingests registry candidates", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const entry = {
      id: "11111111-1111-1111-1111-111111111111",
      provider: "local",
      providerId: "md-1",
      title: "Example",
      createdAt: 1,
      updatedAt: 2,
      providers: [{ provider: "mangadex", externalId: "md-1", updatedAt: 2 }],
    };
    const client = createPersonalApiClient(
      async (request) => {
        requests.push(request);
        if (request.url.includes("/v1/registry/ingest")) {
          return { status: 200, body: entry };
        }
        if (request.url.includes("/v1/registry/search")) {
          return { status: 200, body: { entries: [entry] } };
        }
        return {
          status: 200,
          body: {
            entries: [{ ...entry, state: { entryId: entry.id, status: "reading", updatedAt: 3 } }],
          },
        };
      },
      { origin: "https://personal.test", token: "secret" },
    );

    await expect(client.searchRegistry(" Example ")).resolves.toEqual([entry]);
    await expect(client.listRegistry(100, 2)).resolves.toMatchObject([
      { id: entry.id, state: { status: "reading" } },
    ]);
    await expect(
      client.ingestCandidate({
        provider: "mangadex",
        providerId: "md-1",
        title: "Example",
        links: [{ provider: "anilist", externalId: "42" }],
      }),
    ).resolves.toEqual(entry);

    expect(requests.map((request) => request.url)).toEqual([
      "https://personal.test/v1/registry/search?q=Example&limit=25",
      "https://personal.test/v1/registry?limit=100&offset=2",
      "https://personal.test/v1/registry/ingest",
    ]);
    expect(JSON.parse(requests[2]?.body ?? "{}")).toEqual({
      provider: "mangadex",
      providerId: "md-1",
      title: "Example",
      links: [{ provider: "anilist", externalId: "42" }],
    });
  });

  it("reads progress and posts an idempotent chapter-read event", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const client = createPersonalApiClient(
      async (request): Promise<PersonalApiResponse> => {
        requests.push(request);
        if (request.method === "GET") {
          return { status: 200, body: { progress: null } };
        }
        return {
          status: 200,
          body: {
            entryId: "anilist:1",
            chapterKey: "mangadex:chapter-1",
            provider: "mangadex",
            sourceChapterId: "chapter-1",
            readAt: 1_700_000_000_000,
            version: 1,
          },
        };
      },
      { origin: "https://personal.test", token: "secret" },
    );

    await expect(client.getProgress("anilist:1")).resolves.toBeUndefined();
    await expect(
      client.recordRead("anilist:1", {
        eventId: "event-1",
        chapterKey: "mangadex:chapter-1",
        chapterNumber: 1,
        provider: "mangadex",
        sourceMangaId: "manga-1",
        sourceChapterId: "chapter-1",
        readAt: 1_700_000_000_000,
      }),
    ).resolves.toMatchObject({ sourceChapterId: "chapter-1" });

    expect(requests[0]).toMatchObject({
      url: "https://personal.test/v1/entries/anilist%3A1/progress",
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });
    expect(requests[1]).toMatchObject({
      url: "https://personal.test/v1/entries/anilist%3A1/read",
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: "event-1",
        chapterKey: "mangadex:chapter-1",
        chapterNumber: 1,
        provider: "mangadex",
        sourceMangaId: "manga-1",
        sourceChapterId: "chapter-1",
        readAt: 1_700_000_000_000,
      }),
    });
  });

  it("rejects schema-invalid success bodies", async () => {
    const client = createPersonalApiClient(
      async () => ({
        status: 200,
        body: { nope: true },
      }),
      { token: "secret" },
    );

    await expect(client.mangaDexLibrary()).rejects.toEqual(
      new PersonalApiError({ message: "Personal API response failed schema decode (mangadex.library)", status: 502 }),
    );
    await expect(client.resolveEntries([])).rejects.toEqual(
      new PersonalApiError({ message: "Personal API response failed schema decode (canonical.resolveBatch)", status: 502 }),
    );
  });
});
