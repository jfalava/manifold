/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceManga, TrackedMangaChapterReadAction } from "@paperback/types";
import type { PersonalReadInput } from "@manifold/paperback-runtime";

import { processReadActions } from "../src/MANIFOLD/read-queue.js";

// Installs the Application global stub backed by an in-memory map.
import { applicationState, PENDING_PROGRESS_KEY_SAFE } from "./managed-collections-fixtures";
beforeEach(() => {
  applicationState.clear();
});

const manga = (id: string): SourceManga => ({
  mangaId: id,
  mangaInfo: {
    thumbnailUrl: "",
    synopsis: "",
    primaryTitle: id,
    secondaryTitles: [],
    // SAFETY: intentional never-widen for exhaustive/test placeholder
    contentRating: "SAFE" as never,
    additionalInfo: {},
  },
});

const action = (
  id: string,
  chapterId: string,
  chapterNum: number | undefined,
  mangaId = "anilist:141756",
  chapterSourceId = "MangaDex",
  chapterMangaId = "manga-id",
): TrackedMangaChapterReadAction =>
  // SAFETY: test fixture supplies the TrackedMangaChapterReadAction fields processReadActions reads
  ({
    id,
    chapterId,
    chapterSourceId,
    chapterMangaId,
    ...(!(chapterNum === undefined) && { chapterNum }),
    creationDate: new Date(0),
    sourceManga: manga(mangaId),
  }) as TrackedMangaChapterReadAction;

describe("processReadActions", () => {
  it("records every read but pushes AniList once with the highest chapter", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    const result = await processReadActions(
      [action("a3", "c163", 163), action("a2", "c162", 162), action("a1", "c1", 1)],
      { recordRead, pushProgress },
    );

    expect(result.successfulItems).toEqual(["a3", "a2", "a1"]);
    expect(result.failedItems).toEqual([]);
    expect(recordRead).toHaveBeenCalledTimes(3);
    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(163);
  });

  it("keeps the batch max when a later action has a lower chapter", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    await processReadActions(
      [action("a1", "c5", 5), action("a2", "c9", 9), action("a3", "c2", 2)],
      {
        recordRead,
        pushProgress,
      },
    );

    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(9);
  });

  it("failed personal API reads are reported and excluded from the AniList max", async () => {
    const recordRead = vi
      .fn()
      .mockImplementation((_entryId: string, input: PersonalReadInput) =>
        input.eventId === "bad" ? Promise.reject(new Error("HTTP 502")) : Promise.resolve({}),
      );
    const pushProgress = vi.fn().mockResolvedValue(true);

    const result = await processReadActions(
      [action("good", "c10", 10), action("bad", "c11", 11), action("low", "c3", 3)],
      { recordRead, pushProgress },
    );

    expect(result.failedItems).toEqual(["bad"]);
    expect(result.successfulItems).toEqual(["good", "low"]);
    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(10);
  });

  it("pushes once per manga and durably queues thrown progress push failures", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockRejectedValue(new Error("AniList error: Too Many Requests."));

    const result = await processReadActions(
      [action("a", "c1", 4, "anilist:1"), action("b", "c2", 7, "anilist:2")],
      { recordRead, pushProgress },
    );

    expect(result.successfulItems).toEqual(["a", "b"]);
    expect(result.failedItems).toEqual([]);
    // Two immediate pushes only: the same-tick flush skips just-attempted
    // entries instead of doubling upstream load during a rate-limit window.
    expect(pushProgress).toHaveBeenCalledTimes(2);
    // SAFETY: the queued-progress JSON is fully controlled by this test.
    const queued = JSON.parse(String(applicationState.get(PENDING_PROGRESS_KEY_SAFE))) as Record<
      string,
      { chapterNum: number; sourceManga: SourceManga }
    >;
    expect(queued["anilist:1"]).toMatchObject({ chapterNum: 4 });
    expect(queued["anilist:2"]).toMatchObject({ chapterNum: 7 });
    // Only the fields the push reads are persisted — no thumbnails or prose.
    expect(queued["anilist:1"]?.sourceManga).toMatchObject({
      mangaId: "anilist:1",
      mangaInfo: { thumbnailUrl: "", synopsis: "", primaryTitle: "" },
    });
  });

  it("never queues a false push (no token/link): the next read re-pushes", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(false);

    const result = await processReadActions([action("a", "c5", 5, "anilist:1")], {
      recordRead,
      pushProgress,
    });

    expect(result.successfulItems).toEqual(["a"]);
    expect(result.failedItems).toEqual([]);
    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(applicationState.get(PENDING_PROGRESS_KEY_SAFE)).toBeUndefined();
  });

  it("skips queued entries with a missing manga ID instead of retrying forever", async () => {
    applicationState.set(
      PENDING_PROGRESS_KEY_SAFE,
      JSON.stringify({
        "anilist:1": {
          sourceManga: { mangaId: "", mangaInfo: {} },
          chapterNum: 9,
          at: 1,
        },
      }),
    );
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    await processReadActions([], { recordRead, pushProgress });

    expect(pushProgress).not.toHaveBeenCalled();
  });

  it("skips actions without a source chapter ID and actions without chapter numbers still sync reads", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    const result = await processReadActions(
      [action("no-chapter-id", "", 5), action("no-num", "c7", undefined)],
      { recordRead, pushProgress },
    );

    expect(result.failedItems).toEqual(["no-chapter-id"]);
    expect(result.successfulItems).toEqual(["no-num"]);
    expect(recordRead).toHaveBeenCalledTimes(1);
    expect(pushProgress).not.toHaveBeenCalled();
  });

  it("routes reads from their native chapter source and manga IDs", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    await processReadActions(
      [
        action("a", "8295088", 12, "anilist:141756", "Comix", "comix-manga"),
        action("b", "df2e5603-uuid", 13, "anilist:141756", "MangaDex", "md-manga"),
      ],
      { recordRead, pushProgress },
    );

    expect(recordRead).toHaveBeenCalledTimes(2);
    expect(recordRead.mock.calls[0]?.[1]).toMatchObject({
      provider: "comix",
      chapterKey: "comix:8295088",
      sourceMangaId: "comix-manga",
      sourceChapterId: "8295088",
    });
    expect(recordRead.mock.calls[1]?.[1]).toMatchObject({
      provider: "mangadex",
      chapterKey: "mangadex:df2e5603-uuid",
      sourceMangaId: "md-manga",
      sourceChapterId: "df2e5603-uuid",
    });
    // AniList progress is keyed by the anilist-canonical manga either way.
    expect(pushProgress).toHaveBeenCalledTimes(1);
    // SAFETY: optional field is | [SourceManga, number] | undefined when present at this call site
    const progressCall = pushProgress.mock.calls[0] as [SourceManga, number] | undefined;
    expect(progressCall?.[0]?.mangaId).toBe("anilist:141756");
    expect(progressCall?.[1]).toBe(13);
  });

  it("rejects unknown chapter sources instead of treating them as MangaDex", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    const result = await processReadActions(
      [action("bad", "chapter", 1, "anilist:1", "OtherSource")],
      { recordRead, pushProgress },
    );

    expect(result).toEqual({ successfulItems: [], failedItems: ["bad"] });
    expect(recordRead).not.toHaveBeenCalled();
    expect(pushProgress).not.toHaveBeenCalled();
  });

  it("queues a 429'd progress push durably and retries it on the next run", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    let rateLimited = true;
    const pushProgress = vi.fn(async (_sourceManga: SourceManga, _chapterNum: number) => {
      if (rateLimited) {
        throw new Error("AniList error: Too Many Requests.");
      }
      return true;
    });

    const result = await processReadActions([action("a", "c5", 5, "anilist:1")], {
      recordRead,
      pushProgress,
    });

    // The read itself still succeeded and the failed push is queued.
    // Only the fresh attempt fired: the same-tick flush skips just-attempted
    // entries, so the retry waits for the next run.
    expect(result.successfulItems).toEqual(["a"]);
    expect(result.failedItems).toEqual([]);
    expect(pushProgress).toHaveBeenCalledTimes(1);
    // SAFETY: the queued-progress JSON is fully controlled by this test.
    const queued = JSON.parse(String(applicationState.get(PENDING_PROGRESS_KEY_SAFE))) as Record<
      string,
      { chapterNum: number }
    >;
    expect(queued["anilist:1"]).toMatchObject({ chapterNum: 5 });

    // Next run (possibly after a restart): the queued push is retried first.
    rateLimited = false;
    const retried = await processReadActions([], { recordRead, pushProgress });
    expect(retried.successfulItems).toEqual([]);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(5);
    expect(applicationState.get(PENDING_PROGRESS_KEY_SAFE)).toBe("{}");
  });

  it("keeps the queued chapter across a restart and coalesces to the max", async () => {
    // Simulate state written by a previous device session (restart).
    applicationState.set(
      PENDING_PROGRESS_KEY_SAFE,
      JSON.stringify({
        "anilist:1": {
          sourceManga: manga("anilist:1"),
          chapterNum: 9,
          at: 1,
        },
      }),
    );
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    await processReadActions([], { recordRead, pushProgress });

    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(9);
    expect(applicationState.get(PENDING_PROGRESS_KEY_SAFE)).toBe("{}");
  });

  it("a higher fresh chapter supersedes and acknowledges the queued retry", async () => {
    applicationState.set(
      PENDING_PROGRESS_KEY_SAFE,
      JSON.stringify({
        "anilist:1": {
          sourceManga: manga("anilist:1"),
          chapterNum: 9,
          at: 1,
        },
      }),
    );
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    await processReadActions([action("a", "c12", 12, "anilist:1")], { recordRead, pushProgress });

    // The fresh max (12) is pushed; the queued 9 needs no separate retry.
    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(12);
    expect(applicationState.get(PENDING_PROGRESS_KEY_SAFE)).toBe("{}");
  });
});
