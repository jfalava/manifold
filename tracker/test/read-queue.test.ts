import { describe, expect, it, vi } from "vitest";
import type { SourceManga, TrackedMangaChapterReadAction } from "@paperback/types";
import type { PersonalReadInput } from "@manifold/paperback-runtime";

import { processReadActions } from "../src/ManifoldTracker/read-queue.js";

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
): TrackedMangaChapterReadAction =>
  // SAFETY: test fixture supplies the TrackedMangaChapterReadAction fields processReadActions reads
  ({
    id,
    chapterId,
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

    await processReadActions([action("a1", "c5", 5), action("a2", "c9", 9), action("a3", "c2", 2)], {
      recordRead,
      pushProgress,
    });

    expect(pushProgress).toHaveBeenCalledTimes(1);
    expect(pushProgress.mock.calls[0]?.[1]).toBe(9);
  });

  it("failed personal API reads are reported and excluded from the AniList max", async () => {
    const recordRead = vi.fn().mockImplementation((_entryId: string, input: PersonalReadInput) =>
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

  it("pushes once per manga and tolerates progress push failures", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockRejectedValue(new Error("AniList error: Too Many Requests."));

    const result = await processReadActions(
      [action("a", "c1", 4, "anilist:1"), action("b", "c2", 7, "anilist:2")],
      { recordRead, pushProgress },
    );

    expect(result.successfulItems).toEqual(["a", "b"]);
    expect(result.failedItems).toEqual([]);
    expect(pushProgress).toHaveBeenCalledTimes(2);
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

  it("routes comix-prefixed chapters as comix provider reads", async () => {
    const recordRead = vi.fn().mockResolvedValue({});
    const pushProgress = vi.fn().mockResolvedValue(true);

    await processReadActions(
      [action("a", "comix:8295088", 12), action("b", "df2e5603-uuid", 13)],
      { recordRead, pushProgress },
    );

    expect(recordRead).toHaveBeenCalledTimes(2);
    expect(recordRead.mock.calls[0]?.[1]).toMatchObject({
      provider: "comix",
      chapterKey: "comix:8295088",
      sourceChapterId: "8295088",
    });
    expect(recordRead.mock.calls[1]?.[1]).toMatchObject({
      provider: "mangadex",
      chapterKey: "mangadex:df2e5603-uuid",
      sourceChapterId: "df2e5603-uuid",
    });
    // AniList progress is keyed by the anilist-canonical manga either way.
    expect(pushProgress).toHaveBeenCalledTimes(1);
    // SAFETY: optional field is | [SourceManga, number] | undefined when present at this call site
    const progressCall = pushProgress.mock.calls[0] as
      | [SourceManga, number]
      | undefined;
    expect(progressCall?.[0]?.mangaId).toBe("anilist:141756");
    expect(progressCall?.[1]).toBe(13);
  });
});
