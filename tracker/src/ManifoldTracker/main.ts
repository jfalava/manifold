import {
  AdvancedSearchForm,
  ContentRating,
  FlowSection,
  Form,
  InputRow,
  LabelRow,
  OAuthButtonRow,
  SelectRow,
  type Chapter,
  type Extension,
  type MangaProgress,
  type ManagedCollection,
  type ManagedCollectionChangeset,
  type ManagedCollectionProviding,
  type Metadata,
  type MangaProgressProviding,
  type PagedResults,
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
  CanonicalListStateChange,
  CanonicalListStatus,
  CanonicalSearchResult,
} from "@manifold/canonical";
import * as Effect from "effect/Effect";
import { createAniListSource, type CanonicalFetcher } from "@manifold/canonical/sources";
import {
  ANILIST_OAUTH_CLIENT_ID,
  ANILIST_SESSION_KEY,
  ANILIST_STATUS_KEY,
  ANILIST_VIEWER_ID_KEY,
  AniListUnauthorizedError,
  MANIFOLD_API_STATUS_KEY,
  MANIFOLD_API_TOKEN_KEY,
  aniListRequest,
  configuredPersonalApi,
  errorMessage,
  maybeDrainAniListOps,
  saveAniListFields,
  saveAniListProgress,
  saveAniListStatus,
  toCanonicalSearchResult,
  viewerQuery,
  type AniListViewer,
} from "@manifold/paperback-runtime";
import {
  commitManagedCollectionChanges,
  flushPendingNukes,
  getManagedLibraryCollections,
  getSourceMangaInManagedCollection,
} from "./managed-collections.js";
import { processReadActions } from "./read-queue.js";

const piggybackDrain = (): void => {
  maybeDrainAniListOps();
  void flushPendingNukes().catch((error: unknown) => {
    console.error(
      `[ManifoldTracker] pending nuke flush failed:${error instanceof Error ? error.message : String(error)}`,
    );
  });
};

const scheduledAniListFetcher = async (
  input: Parameters<CanonicalFetcher>[0],
  init?: Parameters<CanonicalFetcher>[1],
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  const [response, bodyBuffer] = await Application.scheduleRequest({
    url: String(input),
    method: init?.method ?? "GET",
    headers,
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  });
  const body = Application.arrayBufferToUTF8String(bodyBuffer);
  const headerBag = {
    get(name: string): string | null {
      const normalized = name.toLocaleLowerCase();
      return (
        Object.entries(response.headers).find(([key]) => key.toLocaleLowerCase() === normalized)
          ?.[1] ?? null
      );
    },
  };
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: headerBag,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  } as unknown as Response;
};

export class ManifoldTrackerSource
  implements
    Extension,
    SearchResultsProviding,
    MangaProgressProviding,
    ManagedCollectionProviding,
    SettingsFormProviding
{
  private readonly canonicalResults = new Map<string, CanonicalSearchResult>();
  private readonly aniList = createAniListSource({
    fetcher: scheduledAniListFetcher,
  });

  async initialise(): Promise<void> {
    console.log("[ManifoldTracker] initialise:ready");
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    piggybackDrain();
    const title = typeof query?.title === "string" ? query.title.trim() : "";
    console.log(`[ManifoldTracker] search:${title || "<empty>"}`);
    if (!title) return { items: [] };

    let results;
    try {
      results = await Effect.runPromise(this.aniList.search(title, { limit: 25 }));
    } catch (error) {
      console.error(`[ManifoldTracker] AniList search failed: ${errorMessage(error)}`);
      throw error;
    }

    let mapped = results;
    try {
      const entries = await configuredPersonalApi().resolveEntries(
        results.map((result) => ({
          provider: "anilist" as const,
          providerId: result.providerId,
          title: result.title,
        })),
      );
      const uuidByAnilist = new Map(
        entries.flatMap((entry) => {
          const link = entry.providers.find((provider) => provider.provider === "anilist");
          return link ? [[link.externalId, entry.id] as const] : [];
        }),
      );
      mapped = results.map((result) => {
        const uuid = uuidByAnilist.get(result.providerId);
        return uuid ? { ...result, id: uuid } : result;
      });
    } catch (error) {
      console.error(`[ManifoldTracker] registry resolve failed: ${errorMessage(error)}`);
    }

    for (const entry of mapped) this.canonicalResults.set(entry.id, entry);
    return { items: mapped.map(toCanonicalSearchResult) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    piggybackDrain();
    const personalApi = configuredPersonalApi();
    let entry = this.canonicalResults.get(mangaId);
    if (!entry) {
      const stored = await personalApi.getEntry(mangaId);
      if (!stored) throw new Error(`Registry entry not found: ${mangaId}`);
      const aniLink = stored.providers.find((provider) => provider.provider === "anilist");
      entry = {
        id: stored.id,
        provider: "anilist",
        providerId: aniLink?.externalId ?? stored.providerId,
        title: stored.title,
        aliases: [],
        score: 0,
      };
      this.canonicalResults.set(entry.id, entry);
    }

    const stored = await personalApi.getEntry(mangaId).catch(() => undefined);
    const mdLink = stored?.providers.find((provider) => provider.provider === "mangadex");
    return {
      mangaId: entry.id,
      mangaInfo: {
        thumbnailUrl: entry.metadata?.coverUrl ?? "",
        synopsis: entry.metadata?.description ?? "",
        primaryTitle: entry.title,
        secondaryTitles: [...entry.aliases].filter((title) => title !== entry.title),
        contentRating: ContentRating.EVERYONE,
        status: entry.metadata?.status,
        rating: entry.score,
        additionalInfo: {
          "Canonical ID": entry.id,
          "Canonical provider": "registry",
          ...(aniLinkOf(stored) ? { "AniList ID": aniLinkOf(stored) as string } : {}),
          ...(mdLink
            ? {
                "manifold provider": "mangadex",
                "manifold provider ID": mdLink.externalId,
                ...(mdLink.title ? { "manifold provider title": mdLink.title } : {}),
              }
            : {}),
        },
      },
    };
  }

  getManagedLibraryCollections(): Promise<ManagedCollection[]> {
    console.log("[ManifoldTracker] collections:list");
    return getManagedLibraryCollections();
  }

  getSourceMangaInManagedCollection(
    managedCollection: ManagedCollection,
  ): Promise<SourceManga[]> {
    return getSourceMangaInManagedCollection(managedCollection);
  }

  commitManagedCollectionChanges(changeset: ManagedCollectionChangeset): Promise<void> {
    return commitManagedCollectionChanges(changeset);
  }

  async getMangaProgressManagementForm(sourceManga: SourceManga): Promise<Form> {
    return new TrackerStatusForm(sourceManga);
  }

  async getMangaProgress(sourceManga: SourceManga): Promise<MangaProgress | undefined> {
    try {
      const progress = await configuredPersonalApi().getProgress(sourceManga.mangaId);
      if (!progress?.sourceChapterId) return undefined;

      const lastReadChapterId =
        progress.provider === "comix"
          ? `comix:${progress.sourceChapterId}`
          : progress.sourceChapterId;
      const lastReadChapter: Chapter = {
        chapterId: lastReadChapterId,
        sourceManga,
        langCode: "en",
        chapNum: progress.chapterNumber ?? 0,
        ...(progress.volumeNumber === undefined ? {} : { volume: progress.volumeNumber }),
      };

      return {
        sourceManga,
        lastReadChapter,
        lastReadTime: new Date(progress.readAt),
      };
    } catch (error) {
      console.error(`[ManifoldTracker] progress lookup failed: ${errorMessage(error)}`);
      return undefined;
    }
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
const recordTrackerAniListProgress = async (
  sourceManga: SourceManga,
  chapterNumber: number | undefined,
): Promise<boolean> => {
  const token = Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined;
  if (!token) return false;
  if (typeof chapterNumber !== "number" || !Number.isFinite(chapterNumber) || chapterNumber < 0) {
    return false;
  }
  let anilistId =
    sourceManga.mangaInfo.additionalInfo?.["AniList ID"];
  if (!anilistId) {
    const entry = await configuredPersonalApi().getEntry(sourceManga.mangaId).catch(() => undefined);
    anilistId = aniLinkOf(entry);
  }
  if (!anilistId) return false;
  return saveAniListProgress(token, anilistId, chapterNumber);
};

const STATUS_ALIASES: Record<string, string> = {
  reading: "reading",
  read: "reading",
  current: "reading",
  on_hold: "on_hold",
  "on hold": "on_hold",
  "on-hold": "on_hold",
  hold: "on_hold",
  paused: "on_hold",
  pause: "on_hold",
  plan_to_read: "plan_to_read",
  plan: "plan_to_read",
  planned: "plan_to_read",
  planning: "plan_to_read",
  ptr: "plan_to_read",
  dropped: "dropped",
  drop: "dropped",
  completed: "completed",
  complete: "completed",
  done: "completed",
  re_reading: "re_reading",
  rereading: "re_reading",
  "re-reading": "re_reading",
  reread: "re_reading",
};

const STATUS_LIST_TEXT = Object.keys(STATUS_ALIASES)
  .filter((alias) => STATUS_ALIASES[alias] === alias)
  .join(", ");

/**
 * Per-title list-status editor. Paperback 0.9 never wires managed-collection
 * pushes (the official trackers throw on commit), so the tracker's manage
 * form is the on-device status surface: type a status, submit, and the
 * change lands on AniList immediately with the registry following.
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

  private async loadCurrentStatus(): Promise<void> {
    try {
      const api = configuredPersonalApi();
      if (!this.anilistId) {
        const stored = await api.getEntry(this.entryId).catch(() => undefined);
        this.anilistId = aniLinkOf(stored);
      }
      const state = await api.getListState(this.entryId);
      if (state) {
        this.baseline = state;
        if (state.status) {
          this.statusText = state.status;
          this.selectedStatus = state.status;
          this.statusStyle = "success";
        } else {
          this.statusText = "Not on your list";
          this.statusStyle = "warning";
        }
      } else {
        this.statusText = "Not on your list";
        this.statusStyle = "warning";
      }
    } catch (error) {
      this.statusText = "Unknown";
      this.statusStyle = "warning";
      console.error(`[ManifoldTracker] status load failed:${errorMessage(error)}`);
    }
    this.reloadForm();
  }

  getSections() {
    return [
      FlowSection(
        {
          id: "manifold-tracker-status",
          header: "List status",
          footer:
            "Applies immediately. Reading chapters never changes the status — only this form, the admin panel, or AniList itself do.",
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
            onValueChange: Application.Selector(this as TrackerStatusForm, "statusSelected"),
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
            "Edit what you need and submit; unchanged fields are left alone, cleared fields are emptied on AniList. Dates are YYYY-MM-DD. Chapter progress is intentionally read-driven.",
        },
        [
          InputRow("manifold-tracker-score", {
            title: "Score",
            value: this.baseline?.score !== undefined ? String(this.baseline.score) : "",
            onValueChange: Application.Selector(this as TrackerStatusForm, "scoreChanged"),
          }),
          InputRow("manifold-tracker-volume", {
            title: "Volume progress",
            value:
              this.baseline?.volumeProgress !== undefined
                ? String(this.baseline.volumeProgress)
                : "",
            onValueChange: Application.Selector(this as TrackerStatusForm, "volumeChanged"),
          }),
          InputRow("manifold-tracker-started", {
            title: "Started at",
            value: this.baseline?.startedAt ?? "",
            onValueChange: Application.Selector(this as TrackerStatusForm, "startedChanged"),
          }),
          InputRow("manifold-tracker-completed", {
            title: "Completed at",
            value: this.baseline?.completedAt ?? "",
            onValueChange: Application.Selector(this as TrackerStatusForm, "completedChanged"),
          }),
          InputRow("manifold-tracker-notes", {
            title: "Notes",
            value: this.baseline?.notes ?? "",
            onValueChange: Application.Selector(this as TrackerStatusForm, "notesChanged"),
          }),
        ],
      ),
    ];
  }

  readonly statusSelected = async (value: string[]): Promise<void> => {
    const status = value[0] as CanonicalListStatus | undefined;
    if (!status) return;
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
  private fieldChanges(): CanonicalListStateChange {
    const base = this.baseline;
    const changes: {
      score?: number | null;
      volumeProgress?: number | null;
      startedAt?: string | null;
      completedAt?: string | null;
      notes?: string | null;
    } = {};

    const numberField = (
      pending: string | undefined,
      current: number | undefined,
      key: "score" | "volumeProgress",
    ): void => {
      if (pending === undefined) return;
      const trimmed = pending.trim();
      if (trimmed === "") {
        if (current !== undefined) changes[key] = null;
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number`);
      if (parsed !== current) changes[key] = parsed;
    };

    const dateField = (
      pending: string | undefined,
      current: string | undefined,
      key: "startedAt" | "completedAt",
    ): void => {
      if (pending === undefined) return;
      const trimmed = pending.trim();
      if (trimmed === "") {
        if (current !== undefined) changes[key] = null;
        return;
      }
      if (!/\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        throw new Error(`${key} must be YYYY-MM-DD`);
      }
      if (trimmed !== current) changes[key] = trimmed;
    };

    numberField(this.pendingScore, base?.score, "score");
    numberField(this.pendingVolume, base?.volumeProgress, "volumeProgress");
    dateField(this.pendingStartedAt, base?.startedAt, "startedAt");
    dateField(this.pendingCompletedAt, base?.completedAt, "completedAt");

    if (this.pendingNotes !== undefined) {
      const trimmed = this.pendingNotes.trim();
      if (trimmed === "") {
        if (base?.notes !== undefined) changes.notes = null;
      } else if (trimmed !== base?.notes) {
        changes.notes = trimmed;
      }
    }

    return changes as CanonicalListStateChange;
  }

  override async formDidSubmit(): Promise<void> {
    let changes: CanonicalListStateChange;
    try {
      changes = this.fieldChanges();
    } catch (error) {
      this.lastError = errorMessage(error);
      this.reloadForm();
      return;
    }

    const fieldKeys = Object.keys(changes).filter((key) => key !== "origin" && key !== "appliedRemotely");
    if (fieldKeys.length === 0) return;

    try {
      const api = configuredPersonalApi();
      if (!this.anilistId) {
        const stored = await api.getEntry(this.entryId).catch(() => undefined);
        this.anilistId = aniLinkOf(stored);
      }
      const token = Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined;
      if (!token) throw new Error("Connect AniList in the tracker settings first");
      if (!this.anilistId) throw new Error("This title has no AniList link to update");

      await saveAniListFields(token, this.anilistId, {
        ...(changes.score !== undefined ? { score: changes.score } : {}),
        ...(changes.volumeProgress !== undefined
          ? { volumeProgress: changes.volumeProgress }
          : {}),
        ...(changes.startedAt !== undefined ? { startedAt: changes.startedAt } : {}),
        ...(changes.completedAt !== undefined
          ? { completedAt: changes.completedAt }
          : {}),
        ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
      });
      this.lastError = undefined;
      await api
        .setListState(this.entryId, {
          ...changes,
          origin: "device",
          appliedRemotely: true,
        })
        .catch(() => undefined);
      // Refresh baseline so a second submit treats the new values as saved.
      // Nulls in `changes` mean "cleared", which the registry stores as absent.
      this.baseline = {
        entryId: this.entryId,
        updatedAt: Date.now(),
        ...(this.baseline?.status !== undefined ? { status: this.baseline.status } : {}),
        ...(changes.score !== undefined
          ? changes.score === null
            ? {}
            : { score: changes.score }
          : this.baseline?.score !== undefined
            ? { score: this.baseline.score }
            : {}),
        ...(changes.volumeProgress !== undefined
          ? changes.volumeProgress === null
            ? {}
            : { volumeProgress: changes.volumeProgress }
          : this.baseline?.volumeProgress !== undefined
            ? { volumeProgress: this.baseline.volumeProgress }
            : {}),
        ...(changes.startedAt !== undefined
          ? changes.startedAt === null
            ? {}
            : { startedAt: changes.startedAt }
          : this.baseline?.startedAt !== undefined
            ? { startedAt: this.baseline.startedAt }
            : {}),
        ...(changes.completedAt !== undefined
          ? changes.completedAt === null
            ? {}
            : { completedAt: changes.completedAt }
          : this.baseline?.completedAt !== undefined
            ? { completedAt: this.baseline.completedAt }
            : {}),
        ...(changes.notes !== undefined
          ? changes.notes === null
            ? {}
            : { notes: changes.notes }
          : this.baseline?.notes !== undefined
            ? { notes: this.baseline.notes }
            : {}),
      };
      console.log(`[ManifoldTracker] fields set:${this.anilistId}:${fieldKeys.join(",")}`);
    } catch (error) {
      this.lastError = errorMessage(error);
      console.error(`[ManifoldTracker] fields set failed:${this.lastError}`);
    }
    this.reloadForm();
  }

  private async applyStatus(status: CanonicalListStatus): Promise<void> {
    try {
      const api = configuredPersonalApi();
      if (!this.anilistId) {
        const stored = await api.getEntry(this.entryId).catch(() => undefined);
        this.anilistId = aniLinkOf(stored);
      }
      const token = Application.getSecureState(ANILIST_SESSION_KEY) as string | undefined;
      if (!token) throw new Error("Connect AniList in the tracker settings first");
      if (!this.anilistId) throw new Error("This title has no AniList link to update");

      const result = await saveAniListStatus(token, this.anilistId, status);
      this.statusText = status;
      this.selectedStatus = status;
      this.statusStyle = "success";
      this.lastError = undefined;
      await api
        .setListState(this.entryId, {
          origin: "device",
          appliedRemotely: true,
          status,
        })
        .catch(() => undefined);
      console.log(
        `[ManifoldTracker] status set:${this.anilistId}:${status}:entry=${result.mediaListEntryId ?? "?"}`,
      );
    } catch (error) {
      this.lastError = errorMessage(error);
      console.error(`[ManifoldTracker] status set failed:${this.lastError}`);
    }
    this.reloadForm();
  }
}

class TrackerAdvancedSearchForm extends AdvancedSearchForm {
  getSections() {
    return [
      FlowSection(
        {
          id: "manifold-tracker-search",
          header: "Search filters",
          footer: "Leave filters unchanged to search AniList titles.",
        },
        [
          LabelRow("manifold-tracker-search-info", {
            title: "No additional filters",
            value: "Searches the same registry the content source uses.",
          }),
        ],
      ),
    ];
  }

  getSearchQueryMetadata(): Metadata {
    return {};
  }
}

class TrackerSettingsForm extends Form {
  readonly requiresExplicitSubmission = true;

  private pendingPersonalApiToken?: string;
  private pendingAniListToken?: string;

  getSections() {
    const apiStatus =
      (Application.getState(MANIFOLD_API_STATUS_KEY) as string | undefined) ?? "Not configured";
    const aniListStatus =
      (Application.getState(ANILIST_STATUS_KEY) as string | undefined) ?? "Not connected";
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
            onValueChange: Application.Selector(this as TrackerSettingsForm, "tokenChanged"),
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
            onSuccess: Application.Selector(this as TrackerSettingsForm, "aniListOAuthSuccess"),
          }),
          InputRow("tracker-anilist-token", {
            title: "AniList token",
            value: "",
            onValueChange: Application.Selector(
              this as TrackerSettingsForm,
              "aniListTokenChanged",
            ),
          }),
          LabelRow("tracker-anilist-status", {
            title: "Status",
            value: aniListStatus,
            style: aniListStatus === "Connected" ? "success" : "warning",
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

  readonly aniListOAuthSuccess = async (
    _refreshToken: string,
    accessToken: string,
  ): Promise<void> => {
    const aniListToken = accessToken?.trim();
    if (!aniListToken) return;
    try {
      const viewer = await aniListRequest<AniListViewer>(aniListToken, viewerQuery);
      Application.setSecureState(aniListToken, ANILIST_SESSION_KEY);
      Application.setState(viewer.Viewer.id, ANILIST_VIEWER_ID_KEY);
      Application.setState("Connected", ANILIST_STATUS_KEY);
    } catch (error) {
      console.error(`[ManifoldTracker] AniList OAuth connect failed: ${errorMessage(error)}`);
      const rejected = error instanceof AniListUnauthorizedError;
      Application.setState(
        rejected ? "Token rejected — try logging in again" : "Connect failed — try again",
        ANILIST_STATUS_KEY,
      );
    }
    this.pendingAniListToken = undefined;
    this.reloadForm();
  };

  override async formDidSubmit(): Promise<void> {
    const personalToken = this.pendingPersonalApiToken?.trim();
    if (personalToken) {
      Application.setSecureState(personalToken, MANIFOLD_API_TOKEN_KEY);
      Application.setState("Configured", MANIFOLD_API_STATUS_KEY);
    }

    const aniListToken = this.pendingAniListToken?.trim();
    if (aniListToken) {
      try {
        const viewer = await aniListRequest<AniListViewer>(aniListToken, viewerQuery);
        Application.setSecureState(aniListToken, ANILIST_SESSION_KEY);
        Application.setState(viewer.Viewer.id, ANILIST_VIEWER_ID_KEY);
        Application.setState("Connected", ANILIST_STATUS_KEY);
      } catch (error) {
        console.error(`[ManifoldTracker] AniList connect failed: ${errorMessage(error)}`);
        Application.setState("Connect failed — try again", ANILIST_STATUS_KEY);
      }
    }

    this.pendingPersonalApiToken = undefined;
    this.pendingAniListToken = undefined;
    this.reloadForm();
  }
}

// The exported instance's name must match the extension id (the source
// folder name): Paperback resolves `source.<id>` when loading the bundle.
export class ManifoldTrackerExtension extends ManifoldTrackerSource {}

export const ManifoldTracker = new ManifoldTrackerExtension();
