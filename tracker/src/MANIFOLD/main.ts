/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import {
  ContentRating,
  FlowSection,
  Form,
  InputRow,
  LabelRow,
  OAuthButtonRow,
  SelectRow,
  type Chapter,
  type CloudflareBypassRequestProviding,
  type Cookie,
  type Extension,
  type MangaProgress,
  type ManagedCollection,
  type ManagedCollectionChangeset,
  type ManagedCollectionProviding,
  type Metadata,
  type MangaProgressProviding,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  type SortingOption,
  type SourceManga,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";
import type {
  CanonicalListState,
  CanonicalListStatus,
  CanonicalSearchResult,
} from "@manifold/canonical";
import {
  isFiniteNumber,
  isJsonObject,
  isString,
  manifoldUserAgent,
  requestHref,
  requestInitText,
} from "@manifold/json";
import * as Effect from "effect/Effect";
import type { CanonicalFetcher } from "@manifold/canonical/sources";
import { createMangaDexClient } from "@manifold/mangadex";
import { ComixSource } from "@manifold/paperback-comix";
import { hashIdFromMangaId } from "@manifold/paperback-comix/parser";
import {
  ANILIST_OAUTH_CLIENT_ID,
  ANILIST_SESSION_KEY,
  ANILIST_STATUS_KEY,
  ANILIST_VIEWER_ID_KEY,
  AniListUnauthorizedError,
  canonicalProviderCandidate,
  clearAdminAccessCookies,
  correlateProviderCandidates,
  readAdminAccessStatus,
  MANIFOLD_API_STATUS_KEY,
  MANIFOLD_API_TOKEN_KEY,
  aniListRequest,
  configuredPersonalApi,
  errorMessage,
  maybeDrainAniListOps,
  mangaDexProviderCandidate,
  parseAniListReadingStatus,
  parseProviderCandidateId,
  parseProviderSearchInput,
  providerCandidateId,
  saveAniListFields,
  saveAniListProgress,
  saveAniListStatus,
  safeImageUrl,
  toProviderCandidateSearchResult,
  viewerQuery,
  type AniListViewer,
  type ProviderCandidate,
} from "@manifold/paperback-runtime";
import {
  aniListSessionToken,
  commitManagedCollectionChanges,
  flushPendingNukes,
  getManagedLibraryCollections,
  getSourceMangaInManagedCollection,
} from "./managed-collections.js";
import { processReadActions } from "./read-queue.js";
import { canonicalResultForRegistryEntry } from "./registry-details.js";
import { filterAndRankCanonicalResults, filterAndRankRegistryEntries } from "./search-relevance.js";

const fromPromise = <A>(a: () => Promise<A>) => Effect.tryPromise({ try: a, catch: (c) => c });

const piggybackDrain = (): void => {
  maybeDrainAniListOps();
  void flushPendingNukes().catch((cause) => {
    console.error(`[MANIFOLD] pending nuke flush failed:${errorMessage(cause)}`);
  });
};

const scheduledAniListFetcher = async (
  input: Parameters<CanonicalFetcher>[0],
  init?: Parameters<CanonicalFetcher>[1],
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (isJsonObject(init?.headers)) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (isString(value)) {
        headers[key] = value;
      }
    }
  }
  const requestBody = requestInitText(init);
  const [response, bodyBuffer] = await Application.scheduleRequest({
    url: requestHref(input),
    method: init?.method ?? "GET",
    headers,
    ...(requestBody !== undefined && { body: requestBody }),
  });
  const body = Application.arrayBufferToUTF8String(bodyBuffer);
  const headerBag = {
    get(name: string): string | null {
      const normalized = name.toLocaleLowerCase();
      return (
        Object.entries(response.headers).find(
          ([key]) => key.toLocaleLowerCase() === normalized,
        )?.[1] ?? null
      );
    },
  };
  // SAFETY: scheduleRequest surface is a partial Response used by AniList GraphQL client
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: headerBag,
    text: async () => body,
    // SAFETY: JSON.parse result is validated by AniList response parsers
    json: async () => JSON.parse(body) as unknown,
  } as Response;
};

export class ManifoldTrackerSource
  implements
    Extension,
    SearchResultsProviding,
    MangaProgressProviding,
    ManagedCollectionProviding,
    SettingsFormProviding,
    CloudflareBypassRequestProviding
{
  private readonly canonicalResults = new Map<string, CanonicalSearchResult>();
  private readonly providerCandidates = new Map<string, ProviderCandidate>();
  private readonly mangaDex = createMangaDexClient({
    fetcher: scheduledAniListFetcher,
    limit: 25,
    userAgent: manifoldUserAgent("tracker"),
  });
  private readonly comix = new ComixSource();

  async initialise(): Promise<void> {
    await this.comix.initialise();
    console.log("[MANIFOLD] initialise:ready");
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    await this.comix.saveCloudflareBypassCookies(cookies);
  }

  async cloudflareBypassCompleted(
    request: Request,
    cookies: Cookie[],
    browserStorage: Record<string, string>,
  ): Promise<void> {
    await this.comix.cloudflareBypassCompleted(request, cookies, browserStorage);
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    piggybackDrain();
    const search = parseProviderSearchInput(query.title);
    const title = search.query;
    console.log(`[MANIFOLD] search:${title || "<empty>"}`);
    if (!title) {
      return { items: [] };
    }

    const api = configuredPersonalApi();
    const [registryResult, canonicalResult, mangaDexResult, comixResult] = await Promise.allSettled(
      [
        search.scope === "all" || search.scope === "registry"
          ? api.searchRegistry(title, 25)
          : Promise.resolve([]),
        search.scope === "all" || search.scope === "anilist" || search.scope === "mal"
          ? api
              .searchCanonical(title, 25, search.scope === "all" ? "auto" : search.scope)
              .then((response) => response.results)
          : Promise.resolve([]),
        search.scope === "all" || search.scope === "mangadex"
          ? Effect.runPromise(this.mangaDex.search(title))
          : Promise.resolve([]),
        search.scope === "all" || search.scope === "comix"
          ? this.comix.getSearchResults({ ...query, title }, undefined, undefined)
          : Promise.resolve({ items: [] }),
      ],
    );
    const selectedResult =
      search.scope === "registry"
        ? registryResult
        : search.scope === "anilist" || search.scope === "mal"
          ? canonicalResult
          : search.scope === "mangadex"
            ? mangaDexResult
            : search.scope === "comix"
              ? comixResult
              : undefined;
    if (selectedResult?.status === "rejected") {
      throw selectedResult.reason;
    }
    const items: SearchResultItem[] = [];
    const linkedKeys = new Set<string>();
    const registryEntries =
      registryResult.status === "fulfilled"
        ? filterAndRankRegistryEntries(title, registryResult.value)
        : [];
    const canonicalEntries =
      canonicalResult.status === "fulfilled"
        ? filterAndRankCanonicalResults(title, canonicalResult.value)
        : [];
    const canonicalByIdentity = new Map<string, CanonicalSearchResult>(
      canonicalEntries.map((entry) => [`${entry.provider}:${entry.providerId}`, entry] as const),
    );
    if (registryResult.status === "fulfilled") {
      for (const entry of registryEntries) {
        for (const link of entry.providers) {
          linkedKeys.add(`${link.provider}:${link.externalId}`);
        }
        const canonical = entry.providers
          .map((link) => canonicalByIdentity.get(`${link.provider}:${link.externalId}`))
          .find((result): result is CanonicalSearchResult => result !== undefined);
        items.push({
          mangaId: entry.id,
          title: canonical?.title ?? entry.title,
          subtitle: `Registry · ${entry.providers.map((link) => link.provider).join(" + ")}`,
          imageUrl: safeImageUrl(canonical?.metadata?.coverUrl),
        });
      }
    } else {
      console.error(`[MANIFOLD] registry search failed: ${errorMessage(registryResult.reason)}`);
    }

    const candidates: ProviderCandidate[] = [];
    if (canonicalResult.status === "fulfilled") {
      for (const result of canonicalEntries) {
        const candidate = canonicalProviderCandidate(result);
        const candidateId = providerCandidateId(candidate.provider, candidate.providerId);
        this.canonicalResults.set(candidateId, result);
        candidates.push(candidate);
      }
    } else {
      console.error(`[MANIFOLD] canonical search failed: ${errorMessage(canonicalResult.reason)}`);
    }
    if (mangaDexResult.status === "fulfilled") {
      for (const manga of mangaDexResult.value) {
        candidates.push(mangaDexProviderCandidate(manga));
      }
    } else {
      console.error(`[MANIFOLD] MangaDex search failed: ${errorMessage(mangaDexResult.reason)}`);
    }
    if (comixResult.status === "fulfilled") {
      for (const result of comixResult.value.items) {
        candidates.push({
          provider: "comix",
          providerId: hashIdFromMangaId(result.mangaId),
          title: result.title,
          aliases: [],
          imageUrl: result.imageUrl,
        });
      }
    } else {
      console.error(`[MANIFOLD] Comix search failed: ${errorMessage(comixResult.reason)}`);
    }

    for (const candidate of correlateProviderCandidates(candidates)) {
      if (linkedKeys.has(`${candidate.provider}:${candidate.providerId}`)) {
        continue;
      }
      this.providerCandidates.set(
        providerCandidateId(candidate.provider, candidate.providerId),
        candidate,
      );
      items.push(toProviderCandidateSearchResult(candidate));
    }
    return { items };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    piggybackDrain();
    return Effect.runPromise(this.getMangaDetailsEffect(mangaId));
  }

  private getMangaDetailsEffect(mangaId: string): Effect.Effect<SourceManga, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const personalApi = configuredPersonalApi();
      const parsedCandidate = parseProviderCandidateId(mangaId);
      if (parsedCandidate) {
        const candidate = self.providerCandidates.get(mangaId);
        if (parsedCandidate.provider === "anilist" || parsedCandidate.provider === "mal") {
          const provider = parsedCandidate.provider;
          const providerId = parsedCandidate.providerId;
          const canonical =
            self.canonicalResults.get(mangaId) ??
            (yield* fromPromise(() => personalApi.getCanonical(provider, providerId)));
          if (!canonical) {
            throw new Error(`${provider} title not found: ${providerId}`);
          }
          const stored = yield* fromPromise(() =>
            personalApi.ingestCandidate({
              provider,
              providerId,
              title: canonical.title,
              links: [...(candidate?.links ?? canonicalProviderCandidate(canonical).links ?? [])],
            }),
          );
          self.canonicalResults.set(stored.id, { ...canonical, id: stored.id, score: 0 });
          return yield* self.getMangaDetailsEffect(stored.id);
        }
        if (parsedCandidate.provider === "mangadex") {
          const manga = yield* self.mangaDex.getManga(parsedCandidate.providerId);
          const stored = yield* fromPromise(() =>
            personalApi.ingestCandidate({
              provider: "mangadex",
              providerId: manga.id,
              title: manga.title,
              links: [
                ...(manga.anilistId
                  ? [{ provider: "anilist" as const, externalId: manga.anilistId }]
                  : []),
                ...(manga.myAnimeListId
                  ? [{ provider: "mal" as const, externalId: manga.myAnimeListId }]
                  : []),
              ],
            }),
          );
          return self.trackerMangaFromCandidate(
            stored.id,
            {
              provider: "mangadex",
              providerId: manga.id,
              title: manga.title,
              aliases: manga.altTitles,
              imageUrl: safeImageUrl(manga.coverUrl),
              description: manga.description,
            },
            manga.anilistId,
          );
        }
        if (parsedCandidate.provider === "comix") {
          const details = yield* fromPromise(() =>
            self.comix.getMangaDetails(parsedCandidate.providerId),
          );
          const stored = yield* fromPromise(() =>
            personalApi.ingestCandidate({
              provider: "comix",
              providerId: parsedCandidate.providerId,
              title: candidate?.title ?? details.mangaInfo.primaryTitle,
            }),
          );
          return {
            ...details,
            mangaId: stored.id,
            mangaInfo: {
              ...details.mangaInfo,
              thumbnailUrl: safeImageUrl(details.mangaInfo.thumbnailUrl),
              additionalInfo: {
                ...details.mangaInfo.additionalInfo,
                "Canonical ID": stored.id,
                "Canonical provider": "registry",
              },
            },
          };
        }
        throw new Error(`Unsupported provider candidate: ${String(parsedCandidate.provider)}`);
      }
      const stored = yield* fromPromise(() => personalApi.getEntry(mangaId)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      let entry = self.canonicalResults.get(mangaId);
      if (!entry) {
        if (!stored) {
          throw new Error(`Registry entry not found: ${mangaId}`);
        }
        const hydrated = yield* fromPromise(() => personalApi.getRegistryCanonical(mangaId)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        entry = canonicalResultForRegistryEntry(stored, hydrated);
        if (hydrated?.metadata) {
          self.canonicalResults.set(entry.id, entry);
        }
      }

      const anilistLink = aniLinkOf(stored);
      return {
        mangaId: entry.id,
        mangaInfo: {
          thumbnailUrl: safeImageUrl(entry.metadata?.coverUrl),
          synopsis: entry.metadata?.description ?? "",
          primaryTitle: entry.title,
          secondaryTitles: [...entry.aliases].filter((title) => title !== entry.title),
          contentRating: ContentRating.EVERYONE,
          status: entry.metadata?.status,
          rating: entry.score,
          additionalInfo: {
            "Canonical ID": entry.id,
            "Canonical provider": "registry",
            ...(anilistLink && { "AniList ID": anilistLink }),
          },
        },
      };
    });
  }

  private trackerMangaFromCandidate(
    entryId: string,
    candidate: ProviderCandidate,
    anilistId?: string,
  ): SourceManga {
    return {
      mangaId: entryId,
      mangaInfo: {
        thumbnailUrl: safeImageUrl(candidate.imageUrl),
        synopsis: candidate.description ?? "",
        primaryTitle: candidate.title,
        secondaryTitles: [...candidate.aliases],
        contentRating: ContentRating.MATURE,
        additionalInfo: {
          "Canonical ID": entryId,
          "Canonical provider": "registry",
          ...(anilistId && { "AniList ID": anilistId }),
        },
      },
    };
  }

  getManagedLibraryCollections(): Promise<ManagedCollection[]> {
    console.log("[MANIFOLD] collections:list");
    return getManagedLibraryCollections();
  }

  getSourceMangaInManagedCollection(managedCollection: ManagedCollection): Promise<SourceManga[]> {
    return getSourceMangaInManagedCollection(managedCollection);
  }

  commitManagedCollectionChanges(changeset: ManagedCollectionChangeset): Promise<void> {
    return commitManagedCollectionChanges(changeset);
  }

  async getMangaProgressManagementForm(sourceManga: SourceManga): Promise<Form> {
    return new TrackerStatusForm(sourceManga);
  }

  async getMangaProgress(sourceManga: SourceManga): Promise<MangaProgress | undefined> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const progress = yield* fromPromise(() =>
          configuredPersonalApi().getProgress(sourceManga.mangaId),
        );
        if (!progress?.sourceChapterId) {
          return undefined;
        }

        const lastReadChapterId =
          progress.provider === "comix"
            ? `comix:${progress.sourceChapterId}`
            : progress.sourceChapterId;
        const lastReadChapter: Chapter = {
          chapterId: lastReadChapterId,
          sourceManga,
          langCode: "en",
          chapNum: progress.chapterNumber ?? 0,
          ...(!(progress.volumeNumber === undefined) && { volume: progress.volumeNumber }),
        };

        return {
          sourceManga,
          lastReadChapter,
          lastReadTime: new Date(progress.readAt),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            console.error(`[MANIFOLD] progress lookup failed: ${errorMessage(error)}`);
            return undefined;
          }),
        ),
      ),
    );
  }

  async processChapterReadActionQueue(
    actions: TrackedMangaChapterReadAction[],
  ): Promise<{ successfulItems: string[]; failedItems: string[] }> {
    piggybackDrain();
    const result = await processReadActions(actions, {
      recordRead: (entryId, input) => configuredPersonalApi().recordRead(entryId, input),
      pushProgress: recordTrackerAniListProgress,
    });
    piggybackDrain();
    return result;
  }

  async getSettingsForm(): Promise<Form> {
    // Opening tracker settings is a user-initiated sync point: reconnects
    // with no search/details/read activity otherwise leave queued work stale.
    piggybackDrain();
    return new TrackerSettingsForm();
  }
}

const aniLinkOf = (
  stored:
    | {
        readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
      }
    | undefined,
): string | undefined =>
  stored?.providers.find((provider) => provider.provider === "anilist")?.externalId;

/**
 * Tracker-side AniList progress push. Mirrors the source-side behaviour:
 * never mutates list status — collections own status transitions.
 */
const recordTrackerAniListProgressEffect = (
  sourceManga: SourceManga,
  chapterNumber: number | undefined,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* () {
    const token = aniListSessionToken();
    if (!token) {
      return false;
    }
    if (!isFiniteNumber(chapterNumber) || chapterNumber < 0) {
      return false;
    }
    let anilistId = sourceManga.mangaInfo.additionalInfo?.["AniList ID"];
    if (!anilistId) {
      const entry = yield* fromPromise(() =>
        configuredPersonalApi().getEntry(sourceManga.mangaId),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));
      anilistId = aniLinkOf(entry);
    }
    if (!anilistId) {
      return false;
    }
    return yield* fromPromise(() => saveAniListProgress(token, anilistId, chapterNumber));
  });

const recordTrackerAniListProgress = (
  sourceManga: SourceManga,
  chapterNumber: number | undefined,
): Promise<boolean> =>
  Effect.runPromise(recordTrackerAniListProgressEffect(sourceManga, chapterNumber));

interface ListFieldDiff {
  score?: number | null;
  volumeProgress?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  notes?: string | null;
}

/**
 * Per-title list-status editor. Paperback 0.9 never wires managed-collection
 * pushes (the official trackers throw on commit), so the tracker's manage
 * form is the on-device status surface: type a status, submit, and the
 * remote failures leave the change in the registry with a pending retry.
 */
class TrackerStatusForm extends Form {
  readonly requiresExplicitSubmission = true;

  private readonly entryId: string;
  private statusText = "Loading…";
  private statusStyle: "success" | "warning" | undefined = undefined;
  private anilistId?: string;
  private lastError?: string;
  private selectedStatus = "";
  private baseline?: CanonicalListState;
  private pendingScore?: string;
  private pendingVolume?: string;
  private pendingStartedAt?: string;
  private pendingCompletedAt?: string;
  private pendingNotes?: string;

  constructor(private readonly sourceManga: SourceManga) {
    super();
    this.entryId = sourceManga.mangaId;
    this.anilistId = sourceManga.mangaInfo.additionalInfo?.["AniList ID"];
    void this.loadCurrentStatus();
  }

  private loadCurrentStatus(): Promise<void> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const api = configuredPersonalApi();
        if (!self.anilistId) {
          const stored = yield* fromPromise(() => api.getEntry(self.entryId)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          self.anilistId = aniLinkOf(stored);
        }
        const state = yield* fromPromise(() => api.getListState(self.entryId));
        if (state) {
          self.baseline = state;
          if (state.status) {
            self.statusText = state.status;
            self.selectedStatus = state.status;
            self.statusStyle = "success";
          } else {
            self.statusText = "Not on your list";
            self.statusStyle = "warning";
          }
        } else {
          self.statusText = "Not on your list";
          self.statusStyle = "warning";
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            self.statusText = "Unknown";
            self.statusStyle = "warning";
            console.error(`[MANIFOLD] status load failed:${errorMessage(error)}`);
          }),
        ),
        Effect.ensuring(Effect.sync(() => self.reloadForm())),
      ),
    );
  }

  getSections() {
    // oxlint-disable-next-line typescript/no-this-alias -- Selector cannot resolve callback keys from polymorphic this
    const selectorTarget: TrackerStatusForm = this;
    return [
      FlowSection(
        {
          id: "manifold-tracker-status",
          header: "List status",
          footer:
            "Applies to the registry immediately and mirrors to AniList when this entry has an AniList link.",
        },
        [
          LabelRow("manifold-tracker-status-current", {
            title: "Current",
            value: this.statusText,
            style: this.statusStyle,
          }),
          SelectRow("manifold-tracker-status-select", {
            title: "Set status",
            subtitle: "Applies immediately",
            value: this.selectedStatus === "" ? [] : [this.selectedStatus],
            minItemCount: 1,
            maxItemCount: 1,
            layout: "flow",
            items: [
              { id: "reading", title: "Reading" },
              { id: "on_hold", title: "On Hold" },
              { id: "plan_to_read", title: "Plan to Read" },
              { id: "dropped", title: "Dropped" },
              { id: "re_reading", title: "Re-reading" },
              { id: "completed", title: "Completed" },
            ],
            onValueChange: Application.Selector(selectorTarget, "statusSelected"),
          }),
          ...(this.lastError
            ? [
                LabelRow("manifold-tracker-status-error", {
                  title: "Last attempt",
                  value: this.lastError,
                  style: "warning",
                }),
              ]
            : []),
        ],
      ),
      FlowSection(
        {
          id: "manifold-tracker-entry",
          header: "Entry details",
          footer:
            "Edit what you need and submit; unchanged fields are left alone. Linked entries mirror to AniList. Dates are YYYY-MM-DD.",
        },
        [
          InputRow("manifold-tracker-score", {
            title: "Score",
            value: this.baseline?.score !== undefined ? String(this.baseline.score) : "",
            onValueChange: Application.Selector(selectorTarget, "scoreChanged"),
          }),
          InputRow("manifold-tracker-volume", {
            title: "Volume progress",
            value:
              this.baseline?.volumeProgress !== undefined
                ? String(this.baseline.volumeProgress)
                : "",
            onValueChange: Application.Selector(selectorTarget, "volumeChanged"),
          }),
          InputRow("manifold-tracker-started", {
            title: "Started at",
            value: this.baseline?.startedAt ?? "",
            onValueChange: Application.Selector(selectorTarget, "startedChanged"),
          }),
          InputRow("manifold-tracker-completed", {
            title: "Completed at",
            value: this.baseline?.completedAt ?? "",
            onValueChange: Application.Selector(selectorTarget, "completedChanged"),
          }),
          InputRow("manifold-tracker-notes", {
            title: "Notes",
            value: this.baseline?.notes ?? "",
            onValueChange: Application.Selector(selectorTarget, "notesChanged"),
          }),
        ],
      ),
    ];
  }

  readonly statusSelected = async (value: string[]): Promise<void> => {
    const selected = value[0];
    const status = selected === undefined ? undefined : parseAniListReadingStatus(selected);
    if (!status) {
      return;
    }
    await this.applyStatus(status);
  };

  readonly scoreChanged = async (value: string): Promise<void> => {
    this.pendingScore = value;
  };

  readonly volumeChanged = async (value: string): Promise<void> => {
    this.pendingVolume = value;
  };

  readonly startedChanged = async (value: string): Promise<void> => {
    this.pendingStartedAt = value;
  };

  readonly completedChanged = async (value: string): Promise<void> => {
    this.pendingCompletedAt = value;
  };

  readonly notesChanged = async (value: string): Promise<void> => {
    this.pendingNotes = value;
  };

  // Field-level diff against the loaded baseline: changed -> new value,
  // changed-to-empty -> null (clears upstream), untouched -> omitted.
  private fieldChanges(): ListFieldDiff {
    const base = this.baseline;
    const changes: ListFieldDiff = {};

    const numberField = (
      pending: string | undefined,
      current: number | undefined,
      key: "score" | "volumeProgress",
    ): void => {
      if (pending === undefined) {
        return;
      }
      const trimmed = pending.trim();
      if (trimmed === "") {
        if (current !== undefined) {
          changes[key] = null;
        }
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${key} must be a number`);
      }
      if (parsed !== current) {
        changes[key] = parsed;
      }
    };

    const dateField = (
      pending: string | undefined,
      current: string | undefined,
      key: "startedAt" | "completedAt",
    ): void => {
      if (pending === undefined) {
        return;
      }
      const trimmed = pending.trim();
      if (trimmed === "") {
        if (current !== undefined) {
          changes[key] = null;
        }
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        throw new Error(`${key} must be YYYY-MM-DD`);
      }
      const date = new Date(`${trimmed}T00:00:00Z`);
      if (
        trimmed.startsWith("0000") ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== trimmed
      ) {
        throw new Error(`${key} must be a real calendar date`);
      }
      if (trimmed !== current) {
        changes[key] = trimmed;
      }
    };

    numberField(this.pendingScore, base?.score, "score");
    numberField(this.pendingVolume, base?.volumeProgress, "volumeProgress");
    dateField(this.pendingStartedAt, base?.startedAt, "startedAt");
    dateField(this.pendingCompletedAt, base?.completedAt, "completedAt");

    if (this.pendingNotes !== undefined) {
      const trimmed = this.pendingNotes.trim();
      if (trimmed === "") {
        if (base?.notes !== undefined) {
          changes.notes = null;
        }
      } else if (trimmed !== base?.notes) {
        changes.notes = trimmed;
      }
    }

    return changes;
  }

  override formDidSubmit(): Promise<void> {
    const self = this;
    let changes: ListFieldDiff;
    try {
      changes = self.fieldChanges();
    } catch (error) {
      self.lastError = errorMessage(error);
      self.reloadForm();
      return Promise.resolve();
    }

    const fieldKeys = Object.keys(changes).filter(
      (key) => key !== "origin" && key !== "appliedRemotely",
    );
    if (fieldKeys.length === 0) {
      return Promise.resolve();
    }

    return Effect.runPromise(
      Effect.gen(function* () {
        const api = configuredPersonalApi();
        if (!self.anilistId) {
          const stored = yield* fromPromise(() => api.getEntry(self.entryId)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          self.anilistId = aniLinkOf(stored);
        }
        const token = aniListSessionToken();
        const anilistId = self.anilistId;
        let appliedRemotely = false;
        if (token !== undefined && anilistId !== undefined) {
          const fieldsOutcome = yield* Effect.result(
            fromPromise(() =>
              saveAniListFields(token, anilistId, {
                ...(changes.score !== undefined && { score: changes.score }),
                ...(changes.volumeProgress !== undefined && {
                  volumeProgress: changes.volumeProgress,
                }),
                ...(changes.startedAt !== undefined && { startedAt: changes.startedAt }),
                ...(changes.completedAt !== undefined && { completedAt: changes.completedAt }),
                ...(changes.notes !== undefined && { notes: changes.notes }),
              }),
            ),
          );
          if (fieldsOutcome._tag === "Success") {
            appliedRemotely = true;
          } else {
            console.warn(
              `[MANIFOLD] AniList fields deferred: ${errorMessage(fieldsOutcome.failure)}`,
            );
            appliedRemotely = false;
          }
        }
        self.lastError = undefined;
        yield* fromPromise(() =>
          api.setListState(self.entryId, {
            ...changes,
            origin: "device",
            appliedRemotely,
          }),
        );
        // Refresh baseline so a second submit treats the new values as saved.
        // Nulls in `changes` mean "cleared", which the registry stores as absent.
        self.baseline = {
          entryId: self.entryId,
          updatedAt: Date.now(),
          ...(self.baseline?.status !== undefined && { status: self.baseline.status }),
          ...(changes.score != null && { score: changes.score }),
          ...(changes.score === undefined &&
            self.baseline?.score !== undefined && { score: self.baseline.score }),
          ...(changes.volumeProgress != null && {
            volumeProgress: changes.volumeProgress,
          }),
          ...(changes.volumeProgress === undefined &&
            self.baseline?.volumeProgress !== undefined && {
              volumeProgress: self.baseline.volumeProgress,
            }),
          ...(changes.startedAt != null && { startedAt: changes.startedAt }),
          ...(changes.startedAt === undefined &&
            self.baseline?.startedAt !== undefined && {
              startedAt: self.baseline.startedAt,
            }),
          ...(changes.completedAt != null && { completedAt: changes.completedAt }),
          ...(changes.completedAt === undefined &&
            self.baseline?.completedAt !== undefined && {
              completedAt: self.baseline.completedAt,
            }),
          ...(changes.notes != null && { notes: changes.notes }),
          ...(changes.notes === undefined &&
            self.baseline?.notes !== undefined && { notes: self.baseline.notes }),
        };
        console.log(`[MANIFOLD] fields set:${self.anilistId ?? "local"}:${fieldKeys.join(",")}`);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            self.lastError = errorMessage(error);
            console.error(`[MANIFOLD] fields set failed:${self.lastError}`);
          }),
        ),
        Effect.ensuring(Effect.sync(() => self.reloadForm())),
      ),
    );
  }

  private applyStatus(status: CanonicalListStatus): Promise<void> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const api = configuredPersonalApi();
        if (!self.anilistId) {
          const stored = yield* fromPromise(() => api.getEntry(self.entryId)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          self.anilistId = aniLinkOf(stored);
        }
        const token = aniListSessionToken();
        const anilistId = self.anilistId;
        let result: Awaited<ReturnType<typeof saveAniListStatus>> | undefined;
        if (token !== undefined && anilistId !== undefined) {
          const statusOutcome = yield* Effect.result(
            fromPromise(() => saveAniListStatus(token, anilistId, status)),
          );
          if (statusOutcome._tag === "Success") {
            result = statusOutcome.success;
          } else {
            console.warn(
              `[MANIFOLD] AniList status deferred: ${errorMessage(statusOutcome.failure)}`,
            );
            result = undefined;
          }
        } else {
          result = undefined;
        }
        self.statusText = status;
        self.selectedStatus = status;
        self.statusStyle = "success";
        self.lastError = undefined;
        yield* fromPromise(() =>
          api.setListState(self.entryId, {
            origin: "device",
            appliedRemotely: result !== undefined,
            status,
            ...(result?.backupIdentity && { backupIdentity: result.backupIdentity }),
          }),
        );
        console.log(
          `[MANIFOLD] status set:${self.anilistId ?? "local"}:${status}:` +
            `entry=${result?.mediaListEntryId ?? "?"}`,
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            self.lastError = errorMessage(error);
            console.error(`[MANIFOLD] status set failed:${self.lastError}`);
          }),
        ),
        Effect.ensuring(Effect.sync(() => self.reloadForm())),
      ),
    );
  }
}

class TrackerSettingsForm extends Form {
  readonly requiresExplicitSubmission = true;

  private pendingPersonalApiToken?: string;
  private pendingAniListToken?: string;
  private pendingAdminCommand?: string;

  getSections() {
    // oxlint-disable-next-line typescript/no-this-alias -- Selector cannot resolve callback keys from polymorphic this
    const selectorTarget: TrackerSettingsForm = this;
    const storedApiStatus = Application.getState(MANIFOLD_API_STATUS_KEY);
    const apiStatus = isString(storedApiStatus) ? storedApiStatus : "Not configured";
    const storedAniListStatus = Application.getState(ANILIST_STATUS_KEY);
    const aniListStatus = isString(storedAniListStatus) ? storedAniListStatus : "Not connected";
    const adminStatus = readAdminAccessStatus();
    return [
      FlowSection(
        {
          id: "tracker-personal-api",
          header: "Personal API",
          footer: "Same token as the content source; stored once per device.",
        },
        [
          InputRow("tracker-personal-api-token", {
            title: "API token",
            value: "",
            onValueChange: Application.Selector(selectorTarget, "tokenChanged"),
          }),
          LabelRow("tracker-personal-api-status", {
            title: "Status",
            value: apiStatus,
            style: apiStatus === "Configured" ? "success" : "warning",
          }),
        ],
      ),
      FlowSection(
        {
          id: "tracker-anilist",
          header: "AniList",
          footer: "Login stores the token used for list status and progress.",
        },
        [
          OAuthButtonRow("tracker-anilist-oauth", {
            title: "Login with AniList",
            subtitle: "Opens AniList in a secure sheet and stores the token on this device.",
            authorizeEndpoint: "https://anilist.co/api/v2/oauth/authorize",
            clientId: ANILIST_OAUTH_CLIENT_ID,
            responseType: { type: "token" },
            onSuccess: Application.Selector(selectorTarget, "aniListOAuthSuccess"),
          }),
          InputRow("tracker-anilist-token", {
            title: "AniList token",
            value: "",
            onValueChange: Application.Selector(selectorTarget, "aniListTokenChanged"),
          }),
          LabelRow("tracker-anilist-status", {
            title: "Status",
            value: aniListStatus,
            style: aniListStatus === "Connected" ? "success" : "warning",
          }),
        ],
      ),

      FlowSection(
        {
          id: "tracker-admin",
          header: "Admin panel",
          footer:
            "In-app admin browser is blocked on iOS 27 (Paperback SIGABRT laying out WebViewRow). Open https://manifold.jfa.dev/admin/ in Safari. Type clear + Save if a stored Access session label is stale.",
        },
        [
          LabelRow("tracker-admin-status", {
            title: "Access session",
            value: adminStatus,
            style: adminStatus === "No session" ? "warning" : "success",
          }),
          InputRow("tracker-admin-command", {
            title: "Admin command (clear)",
            value: "",
            onValueChange: Application.Selector(selectorTarget, "adminCommandChanged"),
          }),
        ],
      ),
    ];
  }

  readonly tokenChanged = async (value: string): Promise<void> => {
    this.pendingPersonalApiToken = value;
  };

  readonly aniListTokenChanged = async (value: string): Promise<void> => {
    this.pendingAniListToken = value;
  };

  readonly adminCommandChanged = async (value: string): Promise<void> => {
    this.pendingAdminCommand = value;
  };

  readonly aniListOAuthSuccess = (_refreshToken: string, accessToken: string): Promise<void> => {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const aniListToken = accessToken?.trim();
        if (!aniListToken) {
          return;
        }
        const outcome = yield* Effect.result(
          fromPromise(() => aniListRequest<AniListViewer>(aniListToken, viewerQuery)),
        );
        if (outcome._tag === "Success") {
          Application.setSecureState(aniListToken, ANILIST_SESSION_KEY);
          Application.setState(outcome.success.Viewer.id, ANILIST_VIEWER_ID_KEY);
          Application.setState("Connected", ANILIST_STATUS_KEY);
        } else {
          console.error(
            `[MANIFOLD] AniList OAuth connect failed: ${errorMessage(outcome.failure)}`,
          );
          const rejected = outcome.failure instanceof AniListUnauthorizedError;
          Application.setState(
            rejected ? "Token rejected — try logging in again" : "Connect failed — try again",
            ANILIST_STATUS_KEY,
          );
        }
        self.pendingAniListToken = undefined;
        self.reloadForm();
      }),
    );
  };

  override formDidSubmit(): Promise<void> {
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const personalToken = self.pendingPersonalApiToken?.trim();
        if (personalToken) {
          Application.setSecureState(personalToken, MANIFOLD_API_TOKEN_KEY);
          Application.setState("Configured", MANIFOLD_API_STATUS_KEY);
        }

        const aniListToken = self.pendingAniListToken?.trim();
        if (aniListToken) {
          const outcome = yield* Effect.result(
            fromPromise(() => aniListRequest<AniListViewer>(aniListToken, viewerQuery)),
          );
          if (outcome._tag === "Success") {
            Application.setSecureState(aniListToken, ANILIST_SESSION_KEY);
            Application.setState(outcome.success.Viewer.id, ANILIST_VIEWER_ID_KEY);
            Application.setState("Connected", ANILIST_STATUS_KEY);
          } else {
            console.error(`[MANIFOLD] AniList connect failed: ${errorMessage(outcome.failure)}`);
            Application.setState("Connect failed — try again", ANILIST_STATUS_KEY);
          }
        }

        const adminCommand = self.pendingAdminCommand?.trim().toLowerCase();
        self.pendingPersonalApiToken = undefined;
        self.pendingAniListToken = undefined;
        self.pendingAdminCommand = undefined;

        if (adminCommand === "clear") {
          clearAdminAccessCookies();
          console.log("[MANIFOLD] admin access:cleared");
        }

        self.reloadForm();
      }),
    );
  }
}

// The exported instance's name must match the extension id (the source
// folder name): Paperback resolves `source.<id>` when loading the bundle.
export class ManifoldTrackerExtension extends ManifoldTrackerSource {}

export const MANIFOLD = new ManifoldTrackerExtension();
