import type {
  SourceManga,
  TrackedMangaChapterReadAction,
} from "@paperback/types";

import { isFiniteNumber } from "@manifold/json";
import {
  errorMessage,
  type PersonalReadInput,
  type PersonalReadingProgress,
} from "@manifold/paperback-runtime";

export interface ReadQueueDeps {
  readonly recordRead: (
    entryId: string,
    input: PersonalReadInput,
  ) => Promise<PersonalReadingProgress>;
  readonly pushProgress: (sourceManga: SourceManga, chapterNumber: number) => Promise<boolean>;
}

interface ChapterProvenance {
  readonly provider: "mangadex" | "comix";
  readonly chapterKey: string;
}

const chapterProvenance = (
  chapterSourceId: string,
  sourceChapterId: string,
): ChapterProvenance => {
  if (chapterSourceId === "MangaDex") {
    return { provider: "mangadex", chapterKey: `mangadex:${sourceChapterId}` };
  }
  if (chapterSourceId === "Comix") {
    return { provider: "comix", chapterKey: `comix:${sourceChapterId}` };
  }
  throw new Error(`Unsupported chapter source: ${chapterSourceId}`);
};

export const processReadActions = async (
  actions: readonly TrackedMangaChapterReadAction[],
  deps: ReadQueueDeps,
): Promise<{ successfulItems: string[]; failedItems: string[] }> => {
  const successfulItems: string[] = [];
  const failedItems: string[] = [];
  const maxByManga = new Map<
    string,
    { readonly sourceManga: SourceManga; readonly chapterNum: number }
  >();

  for (const action of actions) {
    try {
      const sourceChapterId = action.readChapter?.chapterId ?? action.chapterId;
      if (!sourceChapterId) {throw new Error("Chapter read action has no source chapter ID");}
      if (!action.chapterMangaId) {throw new Error("Chapter read action has no source manga ID");}

      const provenance = chapterProvenance(action.chapterSourceId, sourceChapterId);
      await deps.recordRead(action.sourceManga.mangaId, {
        eventId: action.id,
        chapterKey: provenance.chapterKey,
        chapterNumber: action.chapterNum,
        provider: provenance.provider,
        sourceMangaId: action.chapterMangaId,
        sourceChapterId,
        readAt: action.creationDate.getTime(),
        ...(!(action.chapterVolume === undefined) && { volumeNumber: action.chapterVolume }),
      });
      successfulItems.push(action.id);
      console.log(`[manifold] read queued:${sourceChapterId}`);

      const num = action.chapterNum;
      if (isFiniteNumber(num) && num >= 0) {
        const current = maxByManga.get(action.sourceManga.mangaId);
        if (!current || num > current.chapterNum) {
          maxByManga.set(action.sourceManga.mangaId, {
            sourceManga: action.sourceManga,
            chapterNum: num,
          });
        }
      }
    } catch (error) {
      failedItems.push(action.id);
      console.error(`[manifold] read queue failed:${action.id}:${errorMessage(error)}`);
    }
  }

  for (const [mangaId, max] of maxByManga) {
    try {
      if (await deps.pushProgress(max.sourceManga, max.chapterNum)) {
        console.log(`[manifold] anilist progress:${mangaId}:${max.chapterNum}`);
      }
    } catch (error) {
      console.error(`[manifold] anilist progress failed:${mangaId}:${errorMessage(error)}`);
    }
  }

  return { successfulItems, failedItems };
};
