/** CLI host (Bun process, Effect.gen entry mixed with Node I/O). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import {
  errorMessage,
  isFiniteNumber,
  isJsonObject,
  isString,
  manifoldUserAgent,
  objectField,
  type JsonObject,
} from "@manifold/json";

import type { PhaseReporter } from "@/ui";

/**
 * MangaDex → AniList migration phases, ported from
 * scripts/mangadex-to-anilist.ts. Resumable: export/match persist snapshots
 * under tmpDir and skip already-recorded work on re-run.
 */

const MD_API = "https://api.mangadex.org";
const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const USER_AGENT = manifoldUserAgent("cli");
const REQUEST_INTERVAL_MS = 2_500; // 30/min ÷ 1.25 safety margin → ≤24 req/min
const MD_REQUEST_INTERVAL_MS = 250; // MangaDex global ~5 req/s
const BATCH = 100;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type MdStatus =
  | "reading"
  | "on_hold"
  | "plan_to_read"
  | "dropped"
  | "re_reading"
  | "completed";

export const STATUS_TO_ANILIST: Record<MdStatus, string> = {
  reading: "CURRENT",
  on_hold: "PAUSED",
  plan_to_read: "PLANNING",
  dropped: "DROPPED",
  re_reading: "REPEATING",
  completed: "COMPLETED",
};

export interface MdLibraryEntry {
  mangaDexId: string;
  status: MdStatus;
  title: string;
  altTitles: string[];
  anilistId?: string;
  malId?: string;
}

export interface MatchResult {
  mangaDexId: string;
  status: MdStatus;
  anilistId?: string;
  method?: "links-al" | "mal-link" | "title-exact" | "title-partial";
}

// ---------- shared HTTP helpers ----------

interface GraphQLResponse<A> {
  data?: A;
  errors?: { message?: string }[];
}

const gql = async <A>(token: string, query: string, variables: JsonObject = {}): Promise<A> => {
  const response = await fetch(ANILIST_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "5");
    await sleep(Math.max(retryAfter, 5) * 1000);
    return gql<A>(token, query, variables);
  }
  // SAFETY: HTTP value is the expected GraphQLResponse<A>; if after the preceding check
  const body = (await response.json()) as GraphQLResponse<A>;
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? "?").join("; "));
  }
  if (!response.ok) {
    throw new Error(`AniList HTTP ${response.status}`);
  }
  // SAFETY: value matches A; }; / at this call site
  return body.data as A;
};

/**
 * Resolves the current MangaDex access token lazily so long-running phases
 * pick up refreshed tokens instead of a snapshot taken at startup.
 */
export type MdTokenProvider = () => Promise<string>;

const mdFetch = async <A>(mdToken: string, path: string): Promise<A> => {
  const response = await fetch(`${MD_API}${path}`, {
    headers: {
      authorization: `Bearer ${mdToken}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  if (response.status === 429 || response.status === 403) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "5");
    await sleep(Math.max(retryAfter, 5) * 1000);
    return mdFetch<A>(mdToken, path);
  }
  if (!response.ok) {
    throw new Error(`MangaDex HTTP ${response.status} for ${path}`);
  }
  // SAFETY: parsed JSON matches { data: A }; ret for this trusted/test payload
  const body = (await response.json()) as { data: A };
  return body.data;
};

// ---------- progress rendering ----------

export const normalizeTitle = (title: string): string =>
  title
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ---------- Phase A: export ----------

const paths = (tmpDir: string) => ({
  snapshot: `${tmpDir}/md-library-snapshot.json`,
  matches: `${tmpDir}/md-match-results.json`,
  unmatched: `${tmpDir}/md-unmatched.csv`,
  progress: `${tmpDir}/md-progress.json`,
});

export const loadSnapshot = (tmpDir: string): MdLibraryEntry[] | undefined => {
  const file = paths(tmpDir).snapshot;
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    // SAFETY: parsed JSON matches MdLibraryEntry[]; } c for this trusted/test payload
    return JSON.parse(readFileSync(file, "utf8")) as MdLibraryEntry[];
  } catch {
    return undefined;
  }
};

export const loadMatches = (tmpDir: string): Map<string, MatchResult> => {
  const file = paths(tmpDir).matches;
  if (!existsSync(file)) {
    return new Map();
  }
  try {
    // SAFETY: parsed JSON matches MatchResult[]; r for this trusted/test payload
    const parsed = JSON.parse(readFileSync(file, "utf8")) as MatchResult[];
    return new Map(parsed.map((m) => [m.mangaDexId, m]));
  } catch {
    return new Map();
  }
};

export const phaseExport = async (
  getMdToken: MdTokenProvider,
  tmpDir: string,
  report?: PhaseReporter,
): Promise<MdLibraryEntry[]> => {
  const mdToken = await getMdToken();
  const cached = loadSnapshot(tmpDir);
  if (cached) {
    report?.detail(
      `Snapshot exists: ${cached.length} entries (delete ${paths(tmpDir).snapshot} to re-export)`,
    );
    return cached;
  }

  report?.detail("Fetching MangaDex statuses…");
  // NOTE: /manga/status is one of the few endpoints whose payload is NOT
  // wrapped in a `data` envelope.
  const statusResponse = await fetch(`${MD_API}/manga/status`, {
    headers: {
      authorization: `Bearer ${mdToken}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });
  if (!statusResponse.ok) {
    throw new Error(`MangaDex HTTP ${statusResponse.status} for /manga/status`);
  }
  // SAFETY: MangaDex /manga/status JSON is decoded via isJsonObject / isMdStatus below
  const statusBody: unknown = await statusResponse.json();
  const statuses = isJsonObject(statusBody) ? (objectField(statusBody, "statuses") ?? {}) : {};

  const validStatuses = new Set<string>([
    "reading",
    "on_hold",
    "plan_to_read",
    "dropped",
    "re_reading",
    "completed",
  ]);
  const isMdStatus = (value: unknown): value is MdStatus =>
    isString(value) && validStatuses.has(value);
  const entries: MdLibraryEntry[] = [];
  for (const [id, rawStatus] of Object.entries(statuses)) {
    if (!isMdStatus(rawStatus)) {
      continue;
    }
    entries.push({
      mangaDexId: id,
      status: rawStatus,
      title: "",
      altTitles: [],
    });
  }
  report?.detail(`Got ${entries.length} statuses.`);

  const idToEntry = new Map(entries.map((e) => [e.mangaDexId, e]));
  const ids = [...idToEntry.keys()];
  let fetched = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const params = new URLSearchParams();
    params.set("limit", String(batch.length));
    for (const id of batch) {
      params.append("ids[]", id);
    }
    const mangaList = await mdFetch<
      {
        id: string;
        attributes: {
          title: Record<string, string>;
          altTitles: Record<string, string>[];
          links?: Record<string, string>;
        };
      }[]
    >(mdToken, `/manga?${params.toString()}`);

    for (const m of mangaList) {
      const entry = idToEntry.get(m.id);
      if (!entry) {
        continue;
      }
      const attrs = m.attributes;
      entry.title =
        attrs.title.en ??
        attrs.title["ja-ro"] ??
        attrs.title.ja ??
        Object.values(attrs.title)[0] ??
        "";
      entry.altTitles = attrs.altTitles.flatMap((t) => Object.values(t));
      entry.anilistId =
        attrs.links?.al && /^\d+$/.test(attrs.links.al) ? attrs.links.al : undefined;
      entry.malId = attrs.links?.mal && /^\d+$/.test(attrs.links.mal) ? attrs.links.mal : undefined;
    }

    fetched += mangaList.length;
    report?.progress(fetched, ids.length);

    await sleep(MD_REQUEST_INTERVAL_MS);
  }

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(paths(tmpDir).snapshot, JSON.stringify(entries, null, 2));
  report?.note(`Snapshot saved: ${entries.length} entries → ${paths(tmpDir).snapshot}`);
  return entries;
};

export const loadProgress = (tmpDir: string): Map<string, number> | undefined => {
  const file = paths(tmpDir).progress;
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    // SAFETY: parsed JSON matches Record< string, number >; retur for this trusted/test payload
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    return new Map(Object.entries(parsed));
  } catch {
    return undefined;
  }
};

const saveProgress = (tmpDir: string, progress: Map<string, number>): void => {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(paths(tmpDir).progress, JSON.stringify(Object.fromEntries(progress), null, 2));
};

// ---------- Phase B: match ----------

interface AniListSearchMedia {
  Page: {
    media: {
      id: number;
      title: { romaji?: string; english?: string; userPreferred?: string };
      synonyms?: string[];
    }[];
  };
}

const searchAniListByTitle = async (
  token: string,
  search: string,
): Promise<readonly { id: number; titles: readonly string[] }[]> => {
  const data = await gql<AniListSearchMedia>(
    token,
    `query ($search: String) {
      Page(perPage: 10) {
        media(search: $search, type: MANGA) {
          id
          title { romaji english userPreferred }
          synonyms
        }
      }
    }`,
    { search },
  );
  return (data.Page.media ?? []).map((m) => ({
    id: m.id,
    titles: [m.title.userPreferred, m.title.english, m.title.romaji, ...(m.synonyms ?? [])].filter(
      (t): t is string => Boolean(t),
    ),
  }));
};

export const phaseMatch = async (
  anilistToken: string,
  entries: readonly MdLibraryEntry[],
  tmpDir: string,
  report?: PhaseReporter,
  options?: { useCache?: boolean },
): Promise<MatchResult[]> => {
  const existing = loadMatches(tmpDir);
  const results: MatchResult[] = [];

  let matched = 0;
  let unmatched = 0;
  let skipped = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const cached = existing.get(entry.mangaDexId);
    if (cached && (cached.anilistId || options?.useCache)) {
      results.push(cached);
      if (cached.anilistId) {
        matched += 1;
      } else {
        unmatched += 1;
      }
      skipped += 1;
      continue;
    }

    let result: MatchResult = {
      mangaDexId: entry.mangaDexId,
      status: entry.status,
    };

    // 1) links.al direct
    if (entry.anilistId) {
      result = { ...result, anilistId: entry.anilistId, method: "links-al" };
    }

    // 2) MAL link
    if (!result.anilistId && entry.malId) {
      try {
        const data = await gql<{ Media: { id: number } | null }>(
          anilistToken,
          `query ($idMal: Int) {
            Media(idMal: $idMal, type: MANGA) { id }
          }`,
          { idMal: Number(entry.malId) },
        );
        if (data.Media?.id) {
          result = {
            ...result,
            anilistId: String(data.Media.id),
            method: "mal-link" as const,
          };
        }
        await sleep(REQUEST_INTERVAL_MS);
      } catch {
        // fall through to title search
      }
    }

    // 3) Title search across title + alt titles
    if (!result.anilistId) {
      const candidates = [entry.title, ...entry.altTitles].filter(Boolean);
      let foundExact = false;
      for (const candidate of candidates.slice(0, 6)) {
        if (foundExact) {
          break;
        }
        try {
          const media = await searchAniListByTitle(anilistToken, candidate);
          const normalizedCandidate = normalizeTitle(candidate);
          if (!normalizedCandidate) {
            continue;
          }
          for (const item of media) {
            if (foundExact) {
              break;
            }
            for (const title of item.titles) {
              if (normalizeTitle(title) === normalizedCandidate) {
                result = {
                  ...result,
                  anilistId: String(item.id),
                  method: "title-exact",
                };
                foundExact = true;
                break;
              }
            }
          }
          if (!foundExact) {
            await sleep(REQUEST_INTERVAL_MS);
          }
        } catch {
          continue;
        }
      }
    }

    if (result.anilistId) {
      matched += 1;
    } else {
      unmatched += 1;
    }
    results.push(result);

    const done = index + 1;
    report?.progress(done, entries.length, [
      ["ok", matched],
      ["miss", unmatched],
      ["cached", skipped],
    ]);

    if (done % 25 === 0) {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(paths(tmpDir).matches, JSON.stringify(results, null, 2));
    }
  }

  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(paths(tmpDir).matches, JSON.stringify(results, null, 2));

  const unmatchedRows = results.filter((r) => !r.anilistId);
  report?.note(
    `Match complete: ${results.length - unmatchedRows.length} matched · ${unmatchedRows.length} unmatched (cached=${skipped})`,
  );
  return results;
};

// ---------- Phase C: push ----------

/** Fetch read markers per entry and resolve their max chapter number. */
export const collectProgress = async (
  getMdToken: MdTokenProvider,
  entries: readonly MdLibraryEntry[],
  report?: PhaseReporter,
  options?: { tmpDir?: string; useCache?: boolean },
): Promise<Map<string, number>> => {
  const progressByMdId = new Map<string, number>();
  const cachedProgress =
    options?.tmpDir && options.useCache ? loadProgress(options.tmpDir) : undefined;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (cachedProgress?.has(entry.mangaDexId)) {
      progressByMdId.set(
        entry.mangaDexId,
        // SAFETY: value matches number, ); at this call site
        cachedProgress.get(entry.mangaDexId) as number,
      );
    } else {
      try {
        const mdToken = await getMdToken();
        const markerResponse = await fetch(`${MD_API}/manga/${entry.mangaDexId}/read`, {
          headers: {
            authorization: `Bearer ${mdToken}`,
            accept: "application/json",
            "user-agent": USER_AGENT,
          },
        });
        if (!markerResponse.ok) {
          throw new Error(`HTTP ${markerResponse.status}`);
        }
        // SAFETY: parsed JSON matches { data?: string[]; }; co for this trusted/test payload
        const markerBody = (await markerResponse.json()) as {
          data?: string[];
        };
        const chapterIds = Array.isArray(markerBody.data) ? markerBody.data : [];
        if (chapterIds.length > 0) {
          let maxChapter = 0;
          for (let i = 0; i < chapterIds.length; i += 100) {
            const batch = chapterIds.slice(i, i + 100);
            const params = new URLSearchParams();
            params.set("limit", String(batch.length));
            for (const id of batch) {
              params.append("ids[]", id);
            }
            const chapters = await mdFetch<{ chapter?: string }[]>(
              mdToken,
              `/chapter?${params.toString()}`,
            );
            for (const c of chapters) {
              const num = Number.parseFloat(c.chapter ?? "");
              if (Number.isFinite(num)) {
                maxChapter = Math.max(maxChapter, num);
              }
            }
            await sleep(MD_REQUEST_INTERVAL_MS);
          }
          if (maxChapter >= 1) {
            progressByMdId.set(entry.mangaDexId, Math.floor(maxChapter));
          }
        }
      } catch (cause) {
        report?.problem(`markers failed for ${entry.mangaDexId}: ${errorMessage(cause)}`);
      }
    }

    if (options?.tmpDir && (index + 1) % 25 === 0) {
      saveProgress(options.tmpDir, progressByMdId);
    }
    if ((index + 1) % 25 === 0 || index + 1 === entries.length) {
      report?.progress(index + 1, entries.length);
    }
    await sleep(MD_REQUEST_INTERVAL_MS);
  }
  if (options?.tmpDir) {
    saveProgress(options.tmpDir, progressByMdId);
  }
  report?.note(`Got progress for ${progressByMdId.size}/${entries.length} entries.`);
  return progressByMdId;
};

/** Existing AniList progress (one bulk call): lets us never regress progress
 * that is already ahead of what MangaDex markers claim. */
export const fetchExistingProgress = async (anilistToken: string): Promise<Map<string, number>> => {
  const viewer = await gql<{ Viewer?: { id?: number } }>(anilistToken, `query { Viewer { id } }`);
  const viewerId = viewer.Viewer?.id;
  if (viewerId === undefined) {
    throw new Error("Could not resolve AniList viewer id.");
  }
  const data = await gql<{
    MediaListCollection?: { lists?: { entries?: { mediaId: number; progress?: number }[] }[] };
  }>(
    anilistToken,
    `query ($userId: Int) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists { entries { mediaId progress } }
      }
    }`,
    { userId: viewerId },
  );
  const existingProgress = new Map<string, number>();
  for (const list of data.MediaListCollection?.lists ?? []) {
    for (const e of list.entries ?? []) {
      if (isFiniteNumber(e.progress) && e.mediaId !== undefined) {
        existingProgress.set(String(e.mediaId), e.progress);
      }
    }
  }
  return existingProgress;
};

/** Save matched entries to AniList; returns the push summary. */
export const saveMatches = async (
  anilistToken: string,
  matches: readonly MatchResult[],
  progressByMdId: Map<string, number>,
  existingProgress: Map<string, number> | undefined,
  options: { dryRun: boolean; progress: boolean },
  report?: PhaseReporter,
): Promise<{ done: number; failed: number; withProgress: number }> => {
  const pushable = matches.filter((m) => m.anilistId !== undefined);
  report?.detail(`Entries to push: ${pushable.length}`);

  let done = 0;
  let failed = 0;
  let withProgress = 0;

  for (const match of pushable) {
    const anilistId = match.anilistId;
    if (!anilistId) {
      continue;
    }
    const status = STATUS_TO_ANILIST[match.status];
    // With progress enabled, always send a number: max of what MangaDex
    // markers claim and what AniList already stores — so entries without
    // markers land at 0 ("reading, nothing read") while existing AniList
    // progress is never regressed.
    let progress: number | undefined;
    if (options.progress) {
      const markerProgress = progressByMdId.get(match.mangaDexId);
      const existing = existingProgress?.get(anilistId);
      progress = Math.max(markerProgress ?? 0, existing ?? 0);
    }

    try {
      if (!options.dryRun) {
        await gql(
          anilistToken,
          `mutation ($mediaId: Int!, $status: MediaListStatus${progress !== undefined ? ", $progress: Int" : ""}) {
            SaveMediaListEntry(mediaId: $mediaId, status: $status, private: true${progress !== undefined ? ", progress: $progress" : ""}) { id status private progress }
          }`,
          progress !== undefined
            ? { mediaId: Number(anilistId), status, progress }
            : { mediaId: Number(anilistId), status },
        );
      }
      done += 1;
      if (progress !== undefined) {
        withProgress += 1;
      }
    } catch (cause) {
      failed += 1;
      report?.problem(`${match.mangaDexId} -> ${anilistId} failed: ${errorMessage(cause)}`);
    }

    const current = done + failed;
    if (current % 5 === 0 || current === pushable.length) {
      report?.progress(current, pushable.length, [
        ["ok", done],
        ["fail", failed],
        ["prog", withProgress],
      ]);
    }
    if (!options.dryRun) {
      await sleep(REQUEST_INTERVAL_MS);
    }
  }
  return { done, failed, withProgress };
};
