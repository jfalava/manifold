import type { JsonObject } from "@manifold/json";
import type { SetListStateInput } from "./domain";

/**
 * Builds the device-bound AniList mutation from the requested change, not the
 * resulting projection. In particular, explicit nulls must survive as clears.
 * The one exception is status: AniList has no entry without one, so a cleared
 * status is left out instead of sent as a mutation AniList can only refuse.
 */
export const createAniListListStateOpPayload = (
  entryId: string,
  anilistId: string,
  mediaListEntryId: number | undefined,
  changes: SetListStateInput,
): JsonObject => ({
  entryId,
  anilistId,
  ...(mediaListEntryId !== undefined && { mediaListEntryId }),
  ...(changes.status !== undefined && changes.status !== null && { status: changes.status }),
  ...(changes.score !== undefined && { score: changes.score }),
  ...(changes.notes !== undefined && { notes: changes.notes }),
  ...(changes.startedAt !== undefined && { startedAt: changes.startedAt }),
  ...(changes.completedAt !== undefined && { completedAt: changes.completedAt }),
  ...(changes.volumeProgress !== undefined && { volumeProgress: changes.volumeProgress }),
});
