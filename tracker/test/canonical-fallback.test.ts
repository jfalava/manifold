/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Form, type Request as PaperbackRequest } from "@paperback/types";
import { isJsonObject, isString, type JsonValue } from "@manifold/json";
import { MANIFOLD_API_TOKEN_KEY, ANILIST_SESSION_KEY } from "@manifold/paperback-runtime";
let ManifoldTrackerSource: typeof import("../src/MANIFOLD/main").ManifoldTrackerSource;

const entry = {
  id: "a998f88c-1a5d-46a8-81b7-a3ac92021598",
  provider: "mal",
  providerId: "77",
  title: "Example",
  createdAt: 1,
  updatedAt: 2,
  providers: [{ provider: "mal", externalId: "77", updatedAt: 2 }],
};
const canonical = {
  id: "mal:77",
  provider: "mal",
  providerId: "77",
  title: "Example",
  aliases: ["Alias"],
  score: 0.8,
  externalIds: { mal: "77" },
  metadata: { coverUrl: "https://example.test/mal.jpg", description: "MAL details" },
};

const parseJsonObject = (value: PaperbackRequest["body"]): Record<string, JsonValue> => {
  if (!isString(value)) {
    throw new Error("Expected a JSON request body");
  }
  const parsed: unknown = JSON.parse(value);
  if (!isJsonObject(parsed)) {
    throw new Error("Expected a JSON object request body");
  }
  return parsed;
};

describe("Paperback canonical fallback", () => {
  const requests: PaperbackRequest[] = [];
  let hasAniList = false;
  let registrySearch = false;
  let bareDetails = false;

  beforeEach(async () => {
    requests.length = 0;
    hasAniList = false;
    registrySearch = false;
    bareDetails = false;
    vi.spyOn(Form.prototype, "reloadForm").mockImplementation(() => undefined);
    vi.stubGlobal("Application", {
      getSecureState: (key: string) =>
        key === MANIFOLD_API_TOKEN_KEY
          ? "api-token"
          : key === ANILIST_SESSION_KEY && hasAniList
            ? "anilist-token"
            : undefined,
      getState: () => undefined,
      sleep: async () => undefined,
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
      scheduleRequest: async (request: PaperbackRequest) => {
        requests.push(request);
        const url = new URL(request.url);
        let status = 200;
        let body: JsonValue = {};
        const stored = {
          ...entry,
          providers: [
            ...entry.providers,
            ...(hasAniList ? [{ provider: "anilist", externalId: "42", updatedAt: 2 }] : []),
          ],
        };
        if (url.hostname === "graphql.anilist.co") {
          status = 403;
          body = { errors: [{ message: "Blocked", status: 403 }] };
        } else if (url.pathname.endsWith("/canonical/search")) {
          body = {
            query: "Example",
            results: [canonical],
            providers: [
              { provider: "anilist", results: [], error: { message: "Blocked", status: 403 } },
              { provider: "mal", results: [canonical] },
            ],
          };
        } else if (url.pathname.endsWith("/registry/search")) {
          body = { entries: registrySearch ? [stored] : [] };
        } else if (url.pathname.endsWith("/registry/ingest")) {
          body = stored;
        } else if (url.pathname.endsWith("/canonical/mal/77")) {
          body = canonical;
        } else if (url.pathname.endsWith(`/entries/${entry.id}/canonical`)) {
          body = bareDetails
            ? { id: entry.id, provider: "mal", providerId: "77", title: "Example", aliases: [] }
            : { ...canonical, id: entry.id };
        } else if (url.pathname.endsWith(`/entries/${entry.id}`)) {
          body = stored;
        } else if (url.pathname.endsWith("/list-state")) {
          body =
            request.method === "GET"
              ? { state: { entryId: entry.id, status: "reading", updatedAt: 2 } }
              : { entryId: entry.id, updatedAt: 3, ...parseJsonObject(request.body) };
        } else if (url.hostname === "api.mangadex.org") {
          body = { data: [] };
        } else if (url.pathname.endsWith("/ops")) {
          body = { ops: [] };
        } else {
          status = 503;
          body = { error: "Other provider unavailable" };
        }
        return [{ status, headers: {} }, new TextEncoder().encode(JSON.stringify(body)).buffer];
      },
    });
    ({ ManifoldTrackerSource } = await import("../src/MANIFOLD/main"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses auto search, labels MAL, and ingests the selected candidate with its own ID", async () => {
    const tracker = new ManifoldTrackerSource();
    const result = await tracker.getSearchResults({ title: "Example" }, undefined, undefined);
    expect(result.items).toContainEqual(
      expect.objectContaining({
        mangaId: "provider-candidate:mal:77",
        subtitle: "MyAnimeList · Alias",
      }),
    );
    expect(requests.some((request) => request.url.includes("provider=auto"))).toBe(true);
    const details = await tracker.getMangaDetails("provider-candidate:mal:77");
    expect(details).toMatchObject({
      mangaId: entry.id,
      mangaInfo: {
        primaryTitle: "Example",
        synopsis: "MAL details",
        thumbnailUrl: "https://example.test/mal.jpg",
      },
    });
    expect(details.mangaInfo.additionalInfo?.["AniList ID"]).toBeUndefined();
    expect(
      parseJsonObject(requests.find((request) => request.url.endsWith("/registry/ingest"))?.body),
    ).toEqual({ provider: "mal", providerId: "77", title: "Example", links: [] });
    expect(requests.some((request) => request.url.includes("graphql.anilist.co"))).toBe(false);
  });

  it("hydrates a MAL candidate after reopening without the search cache", async () => {
    const details = await new ManifoldTrackerSource().getMangaDetails("provider-candidate:mal:77");
    expect(details.mangaId).toBe(entry.id);
    expect(requests.some((request) => request.url.endsWith("/canonical/mal/77"))).toBe(true);
  });

  it("deduplicates an already-linked MAL search result against the registry", async () => {
    registrySearch = true;
    const result = await new ManifoldTrackerSource().getSearchResults(
      { title: "Example" },
      undefined,
      undefined,
    );
    expect(result.items).toEqual([
      expect.objectContaining({ mangaId: entry.id, imageUrl: "https://example.test/mal.jpg" }),
    ]);
  });

  it("does not cache degraded registry-only metadata across recovery", async () => {
    const tracker = new ManifoldTrackerSource();
    bareDetails = true;
    expect((await tracker.getMangaDetails(entry.id)).mangaInfo.synopsis).toBe("");
    bareDetails = false;
    expect((await tracker.getMangaDetails(entry.id)).mangaInfo.synopsis).toBe("MAL details");
  });

  it.each([false, true])(
    "saves fields locally with AniList linked=%s even during a 403",
    async (linked) => {
      hasAniList = linked;
      const tracker = new ManifoldTrackerSource();
      const details = await tracker.getMangaDetails(entry.id);
      const form = await tracker.getMangaProgressManagementForm(details);
      // Exercise the public form callback, not the private state implementation.
      // SAFETY: the tracker returns a Form with its public notes callback attached.
      const callbacks = form as Form & {
        notesChanged?: (value: string) => Promise<void>;
      };
      if (callbacks.notesChanged === undefined) {
        throw new Error("Missing notes callback");
      }
      await callbacks.notesChanged("Local notes");
      await form.formDidSubmit?.();
      const save = requests.find(
        (request) => request.method === "POST" && request.url.endsWith("/list-state"),
      );
      expect(parseJsonObject(save?.body)).toEqual({
        notes: "Local notes",
        origin: "device",
        appliedRemotely: false,
      });
    },
  );

  it("saves status locally when AniList rejects the write", async () => {
    hasAniList = true;
    const tracker = new ManifoldTrackerSource();
    const form = await tracker.getMangaProgressManagementForm(
      await tracker.getMangaDetails(entry.id),
    );
    // SAFETY: the tracker returns a Form with its public status callback attached.
    const callbacks = form as Form & {
      statusSelected?: (values: string[]) => Promise<void>;
    };
    if (callbacks.statusSelected === undefined) {
      throw new Error("Missing status callback");
    }
    await callbacks.statusSelected(["completed"]);
    const save = requests.find(
      (request) => request.method === "POST" && request.url.endsWith("/list-state"),
    );
    expect(parseJsonObject(save?.body)).toEqual({
      status: "completed",
      origin: "device",
      appliedRemotely: false,
    });
  });
});
