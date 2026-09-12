/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import type { JsonObject } from "@manifold/json";
import type { SetListStateInput } from "./domain";

/**
 * Builds the device-bound AniList mutation from the requested change, not the
 * resulting projection. In particular, explicit nulls must survive as clears.
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
  ...(changes.status !== undefined && { status: changes.status }),
  ...(changes.score !== undefined && { score: changes.score }),
  ...(changes.notes !== undefined && { notes: changes.notes }),
  ...(changes.startedAt !== undefined && { startedAt: changes.startedAt }),
  ...(changes.completedAt !== undefined && { completedAt: changes.completedAt }),
  ...(changes.volumeProgress !== undefined && { volumeProgress: changes.volumeProgress }),
});
