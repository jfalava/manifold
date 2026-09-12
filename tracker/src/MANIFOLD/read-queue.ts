/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import type { SourceManga, TrackedMangaChapterReadAction } from "@paperback/types";

import { isFiniteNumber, isJsonObject, isString } from "@manifold/json";
import {
  errorMessage,
  type PersonalReadInput,
  type PersonalReadingProgress,
} from "@manifold/paperback-runtime";
import { Effect } from "effect";

const fromPromise = <A>(a: () => Promise<A>) => Effect.tryPromise({ try: a, catch: (c) => c });

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

// AniList progress pushes that threw (HTTP 429, offline, rate limit) are
// queued durably in Application state — surviving restarts — and retried,
// coalesced to the highest chapter per manga, on later read-queue activity.
// A `false` return means there is nothing to push to (no token/link), not a
// transient failure, so it is never queued: queueing it would accumulate dead
// entries that retry forever. The next read of that manga re-pushes anyway.
// Recorded reads never fail because of a progress-push failure, and pushes
// never touch list status (DROPPED stays DROPPED).
//
// Only the fields the push reads (mangaId + additionalInfo) are persisted —
// never thumbnails, synopses, or titles — keeping the state payload small.
interface PendingProgressEntry {
  readonly sourceManga: SourceManga;
  readonly chapterNum: number;
  readonly at: number;
}

type PendingProgressMap = { [mangaId: string]: PendingProgressEntry };

const PENDING_PROGRESS_KEY = "manifold.pending-progress";
const PENDING_PROGRESS_MAX = 200;

const readPendingProgress = (): PendingProgressMap => {
  const raw = Application.getState(PENDING_PROGRESS_KEY);
  if (!isString(raw)) {
    return {};
  }
  try {
    // SAFETY: state was written by queueProgress from a live SourceManga on
    // this device; malformed entries are skipped below.
    const parsed = JSON.parse(raw) as PendingProgressMap;
    if (!isJsonObject(parsed)) {
      return {};
    }
    const entries: [string, PendingProgressEntry][] = [];
    for (const [mangaId, value] of Object.entries(parsed)) {
      if (
        !isJsonObject(value) ||
        !isJsonObject(value["sourceManga"]) ||
        !isString(value["sourceManga"]["mangaId"]) ||
        value["sourceManga"]["mangaId"].length === 0 ||
        !isFiniteNumber(value["chapterNum"]) ||
        value["chapterNum"] < 0 ||
        !isFiniteNumber(value["at"]) ||
        value["at"] < 0
      ) {
        continue;
      }
      // SAFETY: sourceManga is an opaque self-written payload; the progress
      // push only reads mangaId and additionalInfo off it.
      entries.push([
        mangaId,
        {
          sourceManga: value["sourceManga"] as SourceManga,
          chapterNum: value["chapterNum"],
          at: value["at"],
        },
      ]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
};

/** Projects a live SourceManga down to what a progress push reads. */
const slimSourceManga = (manga: SourceManga): SourceManga => ({
  mangaId: manga.mangaId,
  mangaInfo: {
    thumbnailUrl: "",
    synopsis: "",
    primaryTitle: "",
    secondaryTitles: [],
    contentRating: manga.mangaInfo.contentRating,
    ...(manga.mangaInfo.additionalInfo && { additionalInfo: manga.mangaInfo.additionalInfo }),
  },
});

const queueProgress = (mangaId: string, entry: PendingProgressEntry): void => {
  const pending = readPendingProgress();
  const existing = pending[mangaId];
  if (existing !== undefined && existing.chapterNum >= entry.chapterNum) {
    return;
  }
  const ids = Object.keys(pending);
  if (!pending[mangaId] && ids.length >= PENDING_PROGRESS_MAX) {
    let oldestId = ids[0]!;
    for (const id of ids) {
      if (pending[id]!.at < pending[oldestId]!.at) {
        oldestId = id;
      }
    }
    delete pending[oldestId];
  }
  pending[mangaId] = entry;
  Application.setState(JSON.stringify(pending), PENDING_PROGRESS_KEY);
};

const acknowledgeProgress = (mangaId: string, chapterNum: number): void => {
  const pending = readPendingProgress();
  const existing = pending[mangaId];
  if (existing === undefined || existing.chapterNum > chapterNum) {
    return;
  }
  delete pending[mangaId];
  Application.setState(JSON.stringify(pending), PENDING_PROGRESS_KEY);
};

const flushPendingProgressEffect = (
  pushProgress: ReadQueueDeps["pushProgress"],
  skip?: ReadonlySet<string>,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const pending = readPendingProgress();
    let pushed = 0;
    for (const [mangaId, entry] of Object.entries(pending)) {
      if (skip?.has(mangaId)) {
        continue;
      }
      const outcome = yield* Effect.result(
        fromPromise(() => pushProgress(entry.sourceManga, entry.chapterNum)),
      );
      if (outcome._tag === "Failure") {
        // Keep it queued; the next read-queue run retries.
        console.error(
          `[manifold] anilist progress retry failed:${mangaId}:${errorMessage(outcome.failure)}`,
        );
        continue;
      }
      if (outcome.success) {
        acknowledgeProgress(mangaId, entry.chapterNum);
        pushed += 1;
        console.log(`[manifold] anilist progress retry:${mangaId}:${entry.chapterNum}`);
      }
    }
    return pushed;
  });

const chapterProvenance = (chapterSourceId: string, sourceChapterId: string): ChapterProvenance => {
  if (chapterSourceId === "MangaDex") {
    return { provider: "mangadex", chapterKey: `mangadex:${sourceChapterId}` };
  }
  if (chapterSourceId === "Comix") {
    return { provider: "comix", chapterKey: `comix:${sourceChapterId}` };
  }
  throw new Error(`Unsupported chapter source: ${chapterSourceId}`);
};

const processReadActionsEffect = (
  actions: readonly TrackedMangaChapterReadAction[],
  deps: ReadQueueDeps,
): Effect.Effect<{ successfulItems: string[]; failedItems: string[] }> =>
  Effect.gen(function* () {
    console.log(`[manifold] read queue received:${actions.length}`);

    const successfulItems: string[] = [];
    const failedItems: string[] = [];
    const maxByManga = new Map<
      string,
      { readonly sourceManga: SourceManga; readonly chapterNum: number }
    >();

    for (const action of actions) {
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          console.log(
            `[manifold] read action:${action.id}:${action.chapterSourceId}:${action.chapterMangaId}:${action.sourceManga.mangaId}`,
          );
          const sourceChapterId = action.readChapter?.chapterId ?? action.chapterId;
          if (!sourceChapterId) {
            return yield* Effect.fail(new Error("Chapter read action has no source chapter ID"));
          }
          if (!action.chapterMangaId) {
            return yield* Effect.fail(new Error("Chapter read action has no source manga ID"));
          }

          const provenance = yield* Effect.try({
            try: () => chapterProvenance(action.chapterSourceId, sourceChapterId),
            catch: (c) => c,
          });
          yield* fromPromise(() =>
            deps.recordRead(action.sourceManga.mangaId, {
              eventId: action.id,
              chapterKey: provenance.chapterKey,
              chapterNumber: action.chapterNum,
              provider: provenance.provider,
              sourceMangaId: action.chapterMangaId,
              sourceChapterId,
              readAt: action.creationDate.getTime(),
              ...(!(action.chapterVolume === undefined) && { volumeNumber: action.chapterVolume }),
            }),
          );
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
          return action.id;
        }),
      );
      if (outcome._tag === "Success") {
        successfulItems.push(outcome.success);
      } else {
        failedItems.push(action.id);
        console.error(`[manifold] read queue failed:${action.id}:${errorMessage(outcome.failure)}`);
      }
    }

    const attempted = new Set<string>();
    for (const [mangaId, max] of maxByManga) {
      attempted.add(mangaId);
      const outcome = yield* Effect.result(
        fromPromise(() => deps.pushProgress(max.sourceManga, max.chapterNum)),
      );
      if (outcome._tag === "Success") {
        if (outcome.success) {
          acknowledgeProgress(mangaId, max.chapterNum);
          console.log(`[manifold] anilist progress:${mangaId}:${max.chapterNum}`);
        }
        // A `false` return means there is nothing to push to (no token/link),
        // not a transient failure — never queue it. The next read re-pushes.
      } else {
        queueProgress(mangaId, {
          sourceManga: slimSourceManga(max.sourceManga),
          chapterNum: max.chapterNum,
          at: Date.now(),
        });
        console.error(
          `[manifold] anilist progress failed:${mangaId}:${errorMessage(outcome.failure)}`,
        );
      }
    }

    // Retry queued AniList progress pushes (429s, offline) from earlier runs.
    // Entries attempted above are skipped: they just failed or succeeded, so
    // retrying them in the same tick only doubles upstream load during a
    // rate-limit window. Fresh acknowledgements already cleared superseded ones.
    yield* flushPendingProgressEffect(deps.pushProgress, attempted);

    return { successfulItems, failedItems };
  });

export const processReadActions = (
  actions: readonly TrackedMangaChapterReadAction[],
  deps: ReadQueueDeps,
): Promise<{ successfulItems: string[]; failedItems: string[] }> =>
  Effect.runPromise(processReadActionsEffect(actions, deps));
