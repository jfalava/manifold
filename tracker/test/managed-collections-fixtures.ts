/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics schemaSync:off */
import { vi } from "vitest";

import type { PersonalApiClient } from "@manifold/paperback-runtime";
import { ContentRating, type SourceManga } from "@paperback/types";

import { MANAGED_COLLECTIONS } from "../src/MANIFOLD/managed-collections";

export { MANAGED_COLLECTIONS };

export { ANILIST_SESSION_KEY, ANILIST_VIEWER_ID_KEY } from "@manifold/paperback-runtime";

export const PENDING_NUKES_KEY = "manifold.pending-nukes";
export const PENDING_RECONCILES_KEY = "manifold.pending-reconciles";

/** Shared in-memory Application state backing the global stub below. */
export const applicationState = new Map<string, unknown>();

/** Progress-retry queue key (written by read-queue). */
export const PENDING_PROGRESS_KEY_SAFE = "manifold.pending-progress";

const installApplicationStub = (): void => {
  vi.stubGlobal("Application", {
    getState: (key: string) => applicationState.get(key),
    // SAFETY: Paperback's setState(value, key) argument order is kept.
    setState: (value: string, key: string) => {
      applicationState.set(key, value);
    },
    getSecureState: (key: string) => applicationState.get(key),
  });
};
installApplicationStub();

export const sourceManga = (entryId: string, anilistId: string): SourceManga => ({
  mangaId: entryId,
  mangaInfo: {
    thumbnailUrl: "",
    synopsis: "",
    primaryTitle: `Title ${anilistId}`,
    secondaryTitles: [],
    contentRating: ContentRating.MATURE,
    additionalInfo: { "AniList ID": anilistId },
  },
});

export const listState = (
  entryId: string,
): Awaited<ReturnType<PersonalApiClient["setListState"]>> => ({
  entryId,
  updatedAt: 1,
});

export const makeApi = (
  setListState: PersonalApiClient["setListState"],
  nukeEntry: PersonalApiClient["nukeEntry"] = async () => undefined,
): PersonalApiClient =>
  // SAFETY: test double; only setListState/nukeEntry are exercised here.
  ({ setListState, nukeEntry }) as PersonalApiClient;
