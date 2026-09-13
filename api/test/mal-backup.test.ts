/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { CanonicalSearchResult, CanonicalSearchSource } from "@manifold/canonical";
import type { ListStatus, RegistryEntry } from "@manifold/contract";
import { chooseMalMatch, resolveMalBackup, writeMalBackupStatus } from "../src/mal-backup";
import type { Env } from "../src/types";

const candidate = (
  id: string,
  title: string,
  aliases: readonly string[] = [],
): CanonicalSearchResult => ({
  id: `mal:${id}`,
  provider: "mal",
  providerId: id,
  title,
  aliases,
  score: 0,
});
const entry: RegistryEntry = {
  id: "registry-id",
  provider: "anilist",
  providerId: "42",
  title: "English title",
  createdAt: 0,
  updatedAt: 0,
  providers: [{ provider: "anilist", externalId: "42", updatedAt: 0 }],
};
const environment = (): Pick<Env, "AI" | "MANIFOLD_MAL_CLIENT_ID"> => {
  const fixture = {
    MANIFOLD_MAL_CLIENT_ID: "test-client",
    AI: {
      run: async () => {
        throw new Error("Unexpected embedding request");
      },
    },
  };
  // @ts-expect-error Ai's platform brand is wider than this resolver test double.
  return fixture;
};

afterEach(() => vi.unstubAllGlobals());

describe("MAL backup matching", () => {
  it("matches any normalized title or alias, not only the display title", () => {
    expect(
      chooseMalMatch(
        ["English title", "日本語"],
        [
          { entry: candidate("1", "Romaji", ["日本語"]), score: 0 },
          { entry: candidate("2", "Unrelated"), score: 0.99 },
        ],
      ),
    ).toMatchObject({ externalId: "1", method: "title" });
  });

  it("refuses conflicting exact titles even with a large semantic margin", () => {
    expect(
      chooseMalMatch(
        ["Title"],
        [
          { entry: candidate("1", "Title"), score: 0.99 },
          { entry: candidate("2", "TITLE"), score: 0.5 },
        ],
      ),
    ).toBeUndefined();
  });

  it("uses the MangaDex confidence and runner-up margin thresholds", () => {
    const ranked = (score: number, runnerUp: number) => [
      { entry: candidate("1", "Near"), score },
      { entry: candidate("2", "Far"), score: runnerUp },
    ];
    expect(chooseMalMatch(["Query"], ranked(0.8, 0.5))).toBeUndefined();
    expect(chooseMalMatch(["Query"], ranked(0.9, 0.86))).toBeUndefined();
    expect(chooseMalMatch(["Query"], ranked(0.92, 0.8))).toMatchObject({
      externalId: "1",
      method: "semantic",
    });
    expect(chooseMalMatch(["Query"], [])).toBeUndefined();
  });

  it("reuses an explicit binding ahead of supplied metadata without searching", async () => {
    expect(
      await resolveMalBackup(
        environment(),
        {
          ...entry,
          providers: [...entry.providers, { provider: "mal", externalId: "7", updatedAt: 0 }],
        },
        { anilistId: "42", malId: "8", titles: [] },
      ),
    ).toMatchObject({ externalId: "7", method: "binding" });
    expect(
      await resolveMalBackup(environment(), entry, {
        anilistId: "42",
        malId: "8",
        titles: [],
      }),
    ).toMatchObject({ externalId: "8", method: "anilist-id" });
  });

  it("searches all distinct aliases and deduplicates returned MAL identities", async () => {
    const terms: string[] = [];
    const source: CanonicalSearchSource = {
      provider: "mal",
      getById: () => Effect.as(Effect.void, undefined),
      search: (term) => {
        terms.push(term);
        return Effect.succeed([candidate("7", "Other display title", ["日本語"])]);
      },
    };
    expect(
      await resolveMalBackup(
        environment(),
        entry,
        {
          anilistId: "42",
          titles: ["English title", "Romaji", "日本語", "ROMAJI"],
        },
        source,
      ),
    ).toMatchObject({ externalId: "7", method: "title" });
    expect(terms).toEqual(["English title", "Romaji", "日本語"]);
  });

  it("ignores identity metadata from another AniList entry", async () => {
    const terms: string[] = [];
    const source: CanonicalSearchSource = {
      provider: "mal",
      getById: () => Effect.as(Effect.void, undefined),
      search: (term) => {
        terms.push(term);
        return Effect.succeed([]);
      },
    };
    await expect(
      resolveMalBackup(
        environment(),
        entry,
        {
          anilistId: "wrong",
          malId: "8",
          titles: ["Wrong title"],
        },
        source,
      ),
    ).rejects.toThrow("unmatched");
    expect(terms).toEqual(["English title"]);
  });

  it("never accepts a partial search after an alias request fails", async () => {
    const source: CanonicalSearchSource = {
      provider: "mal",
      getById: () => Effect.as(Effect.void, undefined),
      search: (term) =>
        term === "English title"
          ? Effect.succeed([candidate("7", "English title")])
          : Effect.fail({
              _tag: "CanonicalSourceError",
              provider: "mal",
              message: "rate limited",
              status: 429,
            }),
    };
    await expect(
      resolveMalBackup(
        environment(),
        entry,
        {
          anilistId: "42",
          titles: ["Alias"],
        },
        source,
      ),
    ).rejects.toBeDefined();
  });
});

describe("MAL backup status write", () => {
  const statuses: readonly ListStatus[] = [
    "reading",
    "completed",
    "on_hold",
    "dropped",
    "plan_to_read",
    "re_reading",
  ];
  it.each(statuses)("projects %s without overwriting other list fields", async (status) => {
    const fetcher = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await writeMalBackupStatus("7", status, "test-token");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.myanimelist.net/v2/manga/7/my_list_status",
      expect.objectContaining({
        method: "PATCH",
        body: new URLSearchParams({
          status: status === "re_reading" ? "reading" : status,
          is_rereading: String(status === "re_reading"),
        }),
      }),
    );
  });

  it("surfaces failures for durable retry without including credentials", async () => {
    vi.stubGlobal("fetch", async () => new Response("sensitive upstream body", { status: 429 }));
    await expect(writeMalBackupStatus("7", "reading", "test-token")).rejects.toThrow("HTTP 429");
  });
});
