import { vi } from "vitest";

import { isJsonObject, isString, type JsonObject } from "@manifold/json";
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

const unusedApiMethod = (name: string) => (): never => {
  throw new Error(`PersonalApiClient.${name} is not used by this test`);
};

/** Complete `PersonalApiClient` whose methods all throw; spread it and override what a test calls. */
export const unusedApi = (): PersonalApiClient => ({
  searchCanonical: unusedApiMethod("searchCanonical"),
  getRegistryCanonical: unusedApiMethod("getRegistryCanonical"),
  getEntry: unusedApiMethod("getEntry"),
  searchRegistry: unusedApiMethod("searchRegistry"),
  listRegistry: unusedApiMethod("listRegistry"),
  ingestCandidate: unusedApiMethod("ingestCandidate"),
  upsertEntry: unusedApiMethod("upsertEntry"),
  linkProvider: unusedApiMethod("linkProvider"),
  getCanonical: unusedApiMethod("getCanonical"),
  resolveMangaDex: unusedApiMethod("resolveMangaDex"),
  getProgress: unusedApiMethod("getProgress"),
  recordRead: unusedApiMethod("recordRead"),
  mangaDexLibrary: unusedApiMethod("mangaDexLibrary"),
  mangaDexFeed: unusedApiMethod("mangaDexFeed"),
  setMangaDexStatus: unusedApiMethod("setMangaDexStatus"),
  entryByMangaDex: unusedApiMethod("entryByMangaDex"),
  resolveEntry: unusedApiMethod("resolveEntry"),
  resolveEntries: unusedApiMethod("resolveEntries"),
  getListState: unusedApiMethod("getListState"),
  setListState: unusedApiMethod("setListState"),
  nukeEntry: unusedApiMethod("nukeEntry"),
  pendingAniListOps: unusedApiMethod("pendingAniListOps"),
  completeOps: unusedApiMethod("completeOps"),
});

export const makeApi = (
  setListState: PersonalApiClient["setListState"],
  nukeEntry: PersonalApiClient["nukeEntry"] = async () => undefined,
): PersonalApiClient => ({ ...unusedApi(), setListState, nukeEntry });

/** Managed collection at `index`; throws instead of returning undefined. */
export const managedCollection = (index: number): (typeof MANAGED_COLLECTIONS)[number] => {
  const collection = MANAGED_COLLECTIONS[index];

  if (!collection) {
    throw new Error(`No managed collection at ${index}`);
  }

  return collection;
};

/** Parse a JSON object the code under test stored in Application state. */
export const readStoredObject = (key: string): JsonObject => {
  const value = applicationState.get(key);
  const parsed: unknown = isString(value) ? JSON.parse(value) : undefined;

  if (!isJsonObject(parsed)) {
    throw new Error(`${key} does not hold a stored JSON object`);
  }

  return parsed;
};
