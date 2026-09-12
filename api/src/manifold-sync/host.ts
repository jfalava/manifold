import type { MangaDexLibraryItem } from "../domain";
import type { Env } from "../types";

/** DO state passed into free-function sync modules. */
export type SyncHost = {
  ctx: DurableObjectState;
  env: Env;
  mdLibraryCache?: { at: number; data: readonly MangaDexLibraryItem[] };
};
