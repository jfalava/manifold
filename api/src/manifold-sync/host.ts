import type { MangaDexLibraryItem } from "../domain";
import type { Env } from "../types";

/** DO state passed into free-function sync modules. */
export type SyncHost = {
  ctx: DurableObjectState;
  env: Env;
  mdLibraryCache?: { at: number; data: readonly MangaDexLibraryItem[] };
};

/** Statement runner slice of `SqlStorage`; real `ctx.storage.sql` satisfies it. */
export interface SqlExec {
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): { toArray(): T[] };
}

/** Host for modules that only run SQL and read env (migrations, Manifold OAuth). */
export type SqlHost = {
  ctx: { storage: { sql: SqlExec } };
  env: Env;
};
