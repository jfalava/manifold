import { describe, expect, it } from "vitest";
import { createPersonalApiClient, PersonalApiError } from "../src/api";

describe("Paperback personal API client", () => {
  it("adds the secure bearer token and normalizes canonical search", async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const client = createPersonalApiClient(async (request) => {
      requests.push(request);
      return {
        status: 200,
        body: {
          query: "Example",
          results: [{
            id: "anilist:1",
            provider: "anilist",
            providerId: "1",
            title: "Example",
            aliases: ["Example"],
            score: 1,
          }],
        },
      };
    }, { origin: "https://personal.test/", token: "secret" });

    const result = await client.searchCanonical(" One Piece & Co ", 50);

    expect(result.results[0]?.id).toBe("anilist:1");
    expect(requests[0]).toMatchObject({
      url: "https://personal.test/v1/canonical/search?q=One%20Piece%20%26%20Co&provider=anilist&limit=25",
      method: "GET",
      headers: { authorization: "Bearer secret" },
    });
  });

  it("turns a missing entry into undefined and preserves other errors", async () => {
    let calls = 0;
    const client = createPersonalApiClient(async () => {
      calls += 1;
      return { status: calls === 1 ? 404 : 502, body: { error: "upstream unavailable" } };
    }, { token: "secret" });

    await expect(client.getEntry("anilist:1")).resolves.toBeUndefined();
    await expect(client.getEntry("anilist:1")).rejects.toEqual(
      new PersonalApiError("upstream unavailable", 502),
    );
  });

  it("reads progress and posts an idempotent chapter-read event", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const client = createPersonalApiClient(async (request) => {
      requests.push(request);
      if (request.method === "GET") {return { status: 200, body: { progress: null } };}
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
    }, { origin: "https://personal.test", token: "secret" });

    await expect(client.getProgress("anilist:1")).resolves.toBeUndefined();
    await expect(client.recordRead("anilist:1", {
      eventId: "event-1",
      chapterKey: "mangadex:chapter-1",
      chapterNumber: 1,
      provider: "mangadex",
      sourceChapterId: "chapter-1",
      readAt: 1_700_000_000_000,
    })).resolves.toMatchObject({ sourceChapterId: "chapter-1" });

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
        sourceChapterId: "chapter-1",
        readAt: 1_700_000_000_000,
      }),
    });
  });
});
