import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AniListLibraryItem, PersonalApiClient } from "@manifold/paperback-runtime";

import {
  commitManagedCollectionChanges,
  flushPendingNukes,
  flushPendingReconciles,
  getSourceMangaInManagedCollection,
  resolveManagedCollectionEntries,
} from "../src/MANIFOLD/managed-collections";

import {
  ANILIST_SESSION_KEY,
  ANILIST_VIEWER_ID_KEY,
  applicationState,
  listState,
  makeApi,
  managedCollection,
  PENDING_NUKES_KEY,
  PENDING_RECONCILES_KEY,
  readStoredObject,
  sourceManga,
} from "./managed-collections-fixtures";

const mocks = vi.hoisted(() => {
  type Runtime = typeof import("@manifold/paperback-runtime");

  // Holder starts empty; tests install a makeApi() double before use.
  type ApiHolder = { api: PersonalApiClient | undefined };

  const holder: ApiHolder = { api: undefined };

  return Object.assign(holder, {
    saveAniListStatus: vi.fn<Runtime["saveAniListStatus"]>(),
    deleteAniListEntry: vi.fn<Runtime["deleteAniListEntry"]>(),
    fetchAniListLibrary: vi.fn<Runtime["fetchAniListLibrary"]>(),
    fetchAniListMediaListEntryIds: vi.fn<Runtime["fetchAniListMediaListEntryIds"]>(),
  });
});

// SAFETY: managed-collections imports its AniList/registry IO functions
// directly with no DI seam; the module mock stands in for those hard
// boundaries so tests exercise the real queueing logic.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("@manifold/paperback-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@manifold/paperback-runtime")>();

  return {
    ...actual,
    configuredPersonalApi: () => {
      const api = mocks.api;

      if (!api) {
        throw new Error("test api not configured");
      }

      return api;
    },
    saveAniListStatus: (...args: Parameters<typeof actual.saveAniListStatus>) =>
      mocks.saveAniListStatus(...args),
    deleteAniListEntry: (...args: Parameters<typeof actual.deleteAniListEntry>) =>
      mocks.deleteAniListEntry(...args),
    fetchAniListLibrary: (...args: Parameters<typeof actual.fetchAniListLibrary>) =>
      mocks.fetchAniListLibrary(...args),
    fetchAniListMediaListEntryIds: (
      ...args: Parameters<typeof actual.fetchAniListMediaListEntryIds>
    ) => mocks.fetchAniListMediaListEntryIds(...args),
  };
});

const items = (count: number): AniListLibraryItem[] =>
  Array.from({ length: count }, (_, index) => ({
    anilistId: String(index + 1),
    status: "reading",
    title: `Title ${index + 1}`,
  }));

import { isString } from "@manifold/json";

const readAppState = (key: string): string | undefined => {
  const value = applicationState.get(key);

  return isString(value) ? value : undefined;
};

describe("managed collection registry resolution", () => {
  it("omits AniList cards that could not be assigned a registry UUID", async () => {
    mocks.api = {
      ...makeApi(async () => listState("unused")),
      resolveEntries: async () => [],
    };
    mocks.fetchAniListLibrary.mockResolvedValue(items(1));
    applicationState.set(ANILIST_SESSION_KEY, "token");
    applicationState.set(ANILIST_VIEWER_ID_KEY, 1);

    await expect(getSourceMangaInManagedCollection(managedCollection(0))).resolves.toEqual([]);
  });

  it("resolves large shelves in bounded batches", async () => {
    const calls: (readonly { readonly providerId: string }[])[] = [];

    const resolveEntries: PersonalApiClient["resolveEntries"] = async (inputs) => {
      calls.push(inputs);

      return inputs.map((input) => ({
        id: `entry-${input.providerId}`,
        provider: "local" as const,
        providerId: input.providerId,
        title: input.title,
        createdAt: 1,
        updatedAt: 1,
        providers: [
          {
            provider: "anilist" as const,
            externalId: input.providerId,
            updatedAt: 1,
          },
        ],
      }));
    };

    const resolved = await resolveManagedCollectionEntries(items(101), { resolveEntries });

    expect(calls.map((call) => call.length)).toEqual([50, 50, 1]);
    expect(resolved.get("51")?.id).toBe("entry-51");
    expect(resolved.get("101")?.id).toBe("entry-101");
  });

  it("keeps successful batches when one batch fails", async () => {
    const resolveEntries = vi.fn<PersonalApiClient["resolveEntries"]>(async (inputs) => {
      if (inputs[0]?.providerId === "51") {
        throw new Error("HTTP 502");
      }

      return inputs.map((input) => ({
        id: `entry-${input.providerId}`,
        provider: "local" as const,
        providerId: input.providerId,
        title: input.title,
        createdAt: 1,
        updatedAt: 1,
        providers: [
          {
            provider: "anilist" as const,
            externalId: input.providerId,
            updatedAt: 1,
          },
        ],
      }));
    });

    const resolved = await resolveManagedCollectionEntries(items(101), { resolveEntries });

    expect(resolved.get("1")?.id).toBe("entry-1");
    expect(resolved.get("51")).toBeUndefined();
    expect(resolved.get("101")?.id).toBe("entry-101");
  });
});

// ---------- registry reconcile persistence (RC P1, memory 1205) ----------

describe("managed collection registry reconciliation", () => {
  beforeEach(() => {
    applicationState.clear();
    applicationState.set(ANILIST_SESSION_KEY, "token");
    applicationState.set(ANILIST_VIEWER_ID_KEY, 1);
    mocks.api = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("persists a failed setListState reconcile and acknowledges it on retry", async () => {
    let failSetListState = true;
    const calls: { entryId: string; status: string }[] = [];
    mocks.api = makeApi(async (entryId, change) => {
      if (failSetListState) {
        throw new Error("HTTP 502");
      }

      calls.push({ entryId, status: String(change.status) });

      return listState(entryId);
    });
    mocks.saveAniListStatus.mockResolvedValue({ mediaListEntryId: 42 });

    await commitManagedCollectionChanges({
      collection: managedCollection(0),
      additions: [sourceManga("entry-1", "A1")],
      deletions: [],
    });

    // Device write succeeded and the failed registry reconcile is queued.
    expect(mocks.saveAniListStatus).toHaveBeenCalledOnce();

    const queued = readStoredObject(PENDING_RECONCILES_KEY);

    expect(queued["entry-1"]).toMatchObject({
      kind: "setListState",
      entryId: "entry-1",
      status: "reading",
    });

    failSetListState = false;
    const acknowledged = await flushPendingReconciles();
    expect(acknowledged).toBe(1);
    expect(calls).toEqual([{ entryId: "entry-1", status: "reading" }]);
    expect(readAppState(PENDING_RECONCILES_KEY)).toBe("{}");
  });

  it("keeps the queued reconcile across a restart until acknowledged", async () => {
    // Simulate state written by a previous device session (restart).
    applicationState.set(
      PENDING_RECONCILES_KEY,
      JSON.stringify({
        "entry-9": {
          kind: "setListState",
          entryId: "entry-9",
          status: "dropped",
          backupIdentity: { anilistId: "A9", titles: ["Title 9"] },
          at: 1,
        },
      }),
    );
    const nukeCalls: string[] = [];
    const setListStateCalls: { entryId: string; backupIdentity?: unknown }[] = [];
    mocks.api = makeApi(
      async (entryId, change) => {
        setListStateCalls.push({ entryId, backupIdentity: change.backupIdentity });

        return listState(entryId);
      },
      async (entryId) => {
        nukeCalls.push(entryId);
      },
    );

    const acknowledged = await flushPendingReconciles();

    expect(acknowledged).toBe(1);
    expect(setListStateCalls).toEqual([
      { entryId: "entry-9", backupIdentity: { anilistId: "A9", titles: ["Title 9"] } },
    ]);
    expect(nukeCalls).toEqual([]);
    expect(readAppState(PENDING_RECONCILES_KEY)).toBe("{}");
  });

  it("does not acknowledge a newer reconcile written while an older one is in flight", async () => {
    applicationState.set(
      PENDING_RECONCILES_KEY,
      JSON.stringify({
        "entry-1": {
          kind: "setListState",
          entryId: "entry-1",
          status: "reading",
          at: 1,
        },
      }),
    );
    let replaced = false;
    mocks.api = makeApi(async () => {
      if (!replaced) {
        replaced = true;
        applicationState.set(
          PENDING_RECONCILES_KEY,
          JSON.stringify({
            "entry-1": {
              kind: "setListState",
              entryId: "entry-1",
              status: "completed",
              at: 2,
            },
          }),
        );
      }

      return listState("entry-1");
    });

    expect(await flushPendingReconciles()).toBe(1);
    expect(readAppState(PENDING_RECONCILES_KEY)).toContain('"status":"completed"');
  });

  it("ignores corrupt queued reconciles instead of throwing on flush", async () => {
    applicationState.set(
      PENDING_RECONCILES_KEY,
      JSON.stringify({
        "entry-1": { kind: "setListState", entryId: "entry-1", status: "not-a-status", at: 1 },
        "entry-2": { kind: "nukeEntry", entryId: "other", at: 1 },
        "entry-3": { kind: "nukeEntry", entryId: "entry-3", at: -5 },
      }),
    );
    mocks.api = makeApi(
      (entryId) => Promise.resolve(listState(entryId)),
      async () => undefined,
    );

    expect(await flushPendingReconciles()).toBe(0);
    // Corrupt entries are dropped at read time, never retried.
    expect(await flushPendingReconciles()).toBe(0);
  });

  it("queues nukeEntry reconcile when the registry call fails after the AniList delete", async () => {
    const quietAt = Date.now() - 200_000;
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: quietAt },
      }),
    );
    mocks.fetchAniListLibrary.mockResolvedValue([] satisfies AniListLibraryItem[]);
    mocks.fetchAniListMediaListEntryIds.mockResolvedValue({ A1: 42 });
    mocks.deleteAniListEntry.mockResolvedValue(true);

    let nukeAttempts = 0;
    const nukeCalls: string[] = [];
    mocks.api = makeApi(
      () => {
        throw new Error("no setListState expected");
      },
      async (entryId) => {
        nukeAttempts += 1;

        if (nukeAttempts <= 2) {
          throw new Error("HTTP 503");
        }

        nukeCalls.push(entryId);
      },
    );

    const executed = await flushPendingNukes();

    // The AniList side is resolved and the pending nuke removed even though
    // the registry nuke failed twice (nuke attempt + trailing retry); the
    // reconcile stays queued for a later flush.
    expect(executed).toBe(1);
    expect(nukeAttempts).toBe(2);
    expect(JSON.parse(String(readAppState(PENDING_NUKES_KEY)))).toEqual({});

    const reconciles = readStoredObject(PENDING_RECONCILES_KEY);

    expect(reconciles["entry-1"]).toMatchObject({
      kind: "nukeEntry",
      entryId: "entry-1",
    });

    const acknowledged = await flushPendingReconciles();
    expect(acknowledged).toBe(1);
    expect(nukeCalls).toEqual(["entry-1"]);
    expect(readAppState(PENDING_RECONCILES_KEY)).toBe("{}");
  });

  it("cancels a pending nuke when an addition for the same title arrives (move)", async () => {
    const quietAt = Date.now() - 200_000;
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: quietAt },
      }),
    );
    mocks.api = makeApi((entryId) => Promise.resolve(listState(entryId)));
    mocks.saveAniListStatus.mockResolvedValue({ mediaListEntryId: 7 });

    await commitManagedCollectionChanges({
      collection: managedCollection(4),
      additions: [sourceManga("entry-1", "A1")],
      deletions: [],
    });

    // The move addition cancelled the pending nuke before it could fire.
    expect(JSON.parse(String(readAppState(PENDING_NUKES_KEY)))).toEqual({});
    expect(readAppState(PENDING_RECONCILES_KEY)).toBe("{}");
  });

  it("keeps a move's nuke cancelled when the AniList status write fails", async () => {
    const quietAt = Date.now() - 200_000;
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: quietAt },
      }),
    );
    mocks.api = makeApi((entryId) => Promise.resolve(listState(entryId)));
    mocks.saveAniListStatus.mockRejectedValue(new Error("AniList kept rate limiting"));

    await expect(
      commitManagedCollectionChanges({
        collection: managedCollection(4),
        additions: [sourceManga("entry-1", "A1")],
        deletions: [],
      }),
    ).rejects.toThrow("AniList kept rate limiting");

    // Otherwise the next flush deletes the title the user only moved.
    expect(JSON.parse(String(readAppState(PENDING_NUKES_KEY)))).toEqual({});
  });

  it("keeps a nuke pending when AniList does not confirm the delete", async () => {
    const quietAt = Date.now() - 200_000;
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: quietAt },
      }),
    );
    mocks.fetchAniListLibrary.mockResolvedValue([] satisfies AniListLibraryItem[]);
    mocks.fetchAniListMediaListEntryIds.mockResolvedValue({ A1: 42 });
    mocks.deleteAniListEntry.mockResolvedValue(false);

    const nukeCalls: string[] = [];
    mocks.api = makeApi(
      () => {
        throw new Error("no setListState expected");
      },
      async (entryId) => {
        nukeCalls.push(entryId);
      },
    );

    expect(await flushPendingNukes()).toBe(0);
    // The registry row must not be tombstoned while the AniList entry survives.
    expect(nukeCalls).toEqual([]);
    expect(readStoredObject(PENDING_NUKES_KEY)["A1"]).toMatchObject({ entryId: "entry-1" });
  });

  it("keeps a removal queued while another commit's AniList write is in flight", async () => {
    mocks.api = makeApi((entryId) => Promise.resolve(listState(entryId)));
    let finishSave = (): void => undefined;
    mocks.saveAniListStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({ mediaListEntryId: 7 });
        }),
    );

    const addition = commitManagedCollectionChanges({
      collection: managedCollection(0),
      additions: [sourceManga("entry-2", "A2")],
      deletions: [],
    });

    await vi.waitFor(() => {
      expect(mocks.saveAniListStatus).toHaveBeenCalledOnce();
    });

    await commitManagedCollectionChanges({
      collection: managedCollection(0),
      additions: [],
      deletions: [sourceManga("entry-1", "A1")],
    });
    finishSave();
    await addition;

    // The first commit read the queue before the removal was written.
    expect(readStoredObject(PENDING_NUKES_KEY)["A1"]).toMatchObject({ entryId: "entry-1" });
  });

  it("does not fire a nuke that a move cancelled while the flush was fetching the library", async () => {
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: 1 },
      }),
    );
    mocks.api = makeApi((entryId) => Promise.resolve(listState(entryId)));
    mocks.saveAniListStatus.mockResolvedValue({ mediaListEntryId: 7 });
    mocks.fetchAniListMediaListEntryIds.mockResolvedValue({ A1: 42 });
    mocks.deleteAniListEntry.mockResolvedValue(true);
    let moved = false;
    mocks.fetchAniListLibrary.mockImplementation(async () => {
      if (!moved) {
        moved = true;
        await commitManagedCollectionChanges({
          collection: managedCollection(3),
          additions: [sourceManga("entry-1", "A1")],
          deletions: [],
        });
      }

      // The library answer predates the move.
      return [{ anilistId: "A1", status: "reading", title: "Title A1" }];
    });

    expect(await flushPendingNukes()).toBe(0);
    expect(mocks.deleteAniListEntry).not.toHaveBeenCalled();
    expect(readStoredObject(PENDING_NUKES_KEY)).toEqual({});
  });

  it("keeps a removal queued while a flush is deleting another title", async () => {
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: 1 },
      }),
    );
    mocks.api = makeApi((entryId) => Promise.resolve(listState(entryId)));
    mocks.fetchAniListLibrary.mockResolvedValue([] satisfies AniListLibraryItem[]);
    mocks.fetchAniListMediaListEntryIds.mockResolvedValue({ A1: 42 });
    mocks.deleteAniListEntry.mockImplementation(async () => {
      applicationState.set(
        PENDING_NUKES_KEY,
        JSON.stringify({
          A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: 1 },
          A2: { entryId: "entry-2", anilistId: "A2", collectionId: "reading", at: Date.now() },
        }),
      );

      return true;
    });

    expect(await flushPendingNukes()).toBe(1);
    expect(Object.keys(readStoredObject(PENDING_NUKES_KEY))).toEqual(["A2"]);
  });

  it("leaves the registry entry alone when a move cancels the nuke during the AniList delete", async () => {
    applicationState.set(
      PENDING_NUKES_KEY,
      JSON.stringify({
        A1: { entryId: "entry-1", anilistId: "A1", collectionId: "reading", at: 1 },
      }),
    );
    const nukeCalls: string[] = [];
    mocks.api = makeApi(
      (entryId) => Promise.resolve(listState(entryId)),
      (entryId) => {
        nukeCalls.push(entryId);

        return Promise.resolve();
      },
    );
    mocks.fetchAniListLibrary.mockResolvedValue([] satisfies AniListLibraryItem[]);
    mocks.fetchAniListMediaListEntryIds.mockResolvedValue({ A1: 42 });
    mocks.saveAniListStatus.mockResolvedValue({ mediaListEntryId: 7 });
    mocks.deleteAniListEntry.mockImplementation(async () => {
      await commitManagedCollectionChanges({
        collection: managedCollection(3),
        additions: [sourceManga("entry-1", "A1")],
        deletions: [],
      });

      return true;
    });

    expect(await flushPendingNukes()).toBe(0);
    expect(nukeCalls).toEqual([]);
    expect(readStoredObject(PENDING_NUKES_KEY)).toEqual({});
  });
});
