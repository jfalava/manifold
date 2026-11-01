/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import {
  errorMessage,
  isFiniteNumber,
  isJsonArray,
  isJsonObject,
  isString,
  manifoldUserAgent,
  objectField,
  stringField,
  type JsonObject,
} from "@manifold/json";
import { ListStatus } from "@manifold/contract";
import { Effect, Option, Schema } from "effect";

import type { PhaseReporter } from "@/ui";
import {
  cliError,
  fromPromise,
  platformFetch,
  runHost,
  sleep as sleepEffect,
  sleepPromise,
  type CliEffectError,
} from "@/effect-kit";
import { aniListGraphqlEffect } from "@/anilist-request";

/**
 * MangaDex → AniList migration phases, ported from
 * scripts/mangadex-to-anilist.ts. Resumable: export/match persist snapshots
 * under tmpDir and skip already-recorded work on re-run.
 */

const MD_API = "https://api.mangadex.org";
const USER_AGENT = manifoldUserAgent("cli");
const MD_REQUEST_INTERVAL_MS = 250; // MangaDex global ~5 req/s
const BATCH = 100;

/** Promise sleep for callers that still take a Promise delay. */
export const sleep = sleepPromise;

export type MdStatus = ListStatus;

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

const MdLibraryEntrySchema = Schema.Struct({
  mangaDexId: Schema.String,
  status: ListStatus,
  title: Schema.String,
  altTitles: Schema.mutable(Schema.Array(Schema.String)),
  anilistId: Schema.optional(Schema.String),
  malId: Schema.optional(Schema.String),
});

const MatchResultSchema = Schema.Struct({
  mangaDexId: Schema.String,
  status: ListStatus,
  anilistId: Schema.optional(Schema.String),
  method: Schema.optional(
    Schema.Literals(["links-al", "mal-link", "title-exact", "title-partial"]),
  ),
});

const readJsonFile = <A>(file: string, schema: Schema.Codec<A, A>): A | undefined =>
  existsSync(file)
    ? Option.getOrUndefined(
        Schema.decodeOption(Schema.fromJsonString(schema))(readFileSync(file, "utf8")),
      )
    : undefined;

// ---------- shared HTTP helpers ----------

/**
 * Resolves the current MangaDex access token lazily so long-running phases
 * pick up refreshed tokens instead of a snapshot taken at startup.
 */
export type MdTokenProvider = () => Promise<string>;

const mdFetchEffect = (
  mdToken: string,
  path: string,
): Effect.Effect<readonly JsonObject[], CliEffectError> =>
  Effect.gen(function* () {
    const response = yield* fromPromise(() =>
      platformFetch(`${MD_API}${path}`, {
        headers: {
          authorization: `Bearer ${mdToken}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      }),
    ).pipe(Effect.mapError((cause) => cliError(errorMessage(cause))));

    if (response.status === 429 || response.status === 403) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "5");
      yield* sleepEffect(Math.max(retryAfter, 5) * 1000);

      return yield* mdFetchEffect(mdToken, path);
    }

    if (!response.ok) {
      return yield* cliError(`MangaDex HTTP ${response.status} for ${path}`);
    }

    const raw: unknown = yield* fromPromise(() => response.json()).pipe(
      Effect.mapError((cause) => cliError(errorMessage(cause))),
    );

    if (!isJsonObject(raw) || !isJsonArray(raw.data) || !raw.data.every(isJsonObject)) {
      return yield* cliError(`MangaDex returned an invalid data envelope for ${path}`);
    }

    return raw.data;
  });

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

export const loadSnapshot = (tmpDir: string): MdLibraryEntry[] | undefined =>
  readJsonFile(paths(tmpDir).snapshot, Schema.mutable(Schema.Array(MdLibraryEntrySchema)));

export const loadMatches = (tmpDir: string): Map<string, MatchResult> =>
  new Map(
    (readJsonFile(paths(tmpDir).matches, Schema.Array(MatchResultSchema)) ?? []).map((match) => [
      match.mangaDexId,
      match,
    ]),
  );

const phaseExportEffect = (
  getMdToken: MdTokenProvider,
  tmpDir: string,
  report?: PhaseReporter,
): Effect.Effect<MdLibraryEntry[], CliEffectError> =>
  Effect.gen(function* () {
    const mdToken = yield* fromPromise(getMdToken).pipe(
      Effect.mapError((cause) => cliError(errorMessage(cause))),
    );

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
    const statusResponse = yield* fromPromise(() =>
      platformFetch(`${MD_API}/manga/status`, {
        headers: {
          authorization: `Bearer ${mdToken}`,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      }),
    ).pipe(Effect.mapError((cause) => cliError(errorMessage(cause))));

    if (!statusResponse.ok) {
      return yield* cliError(`MangaDex HTTP ${statusResponse.status} for /manga/status`);
    }

    const statusBody: unknown = yield* fromPromise(() => statusResponse.json()).pipe(
      Effect.mapError((cause) => cliError(errorMessage(cause))),
    );

    const statuses = isJsonObject(statusBody) ? (objectField(statusBody, "statuses") ?? {}) : {};

    const isMdStatus = Schema.is(ListStatus);

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

      const mangaList = yield* mdFetchEffect(mdToken, `/manga?${params.toString()}`);

      for (const manga of mangaList) {
        const mangaId = stringField(manga, "id");
        const attrs = objectField(manga, "attributes");
        const title = attrs ? objectField(attrs, "title") : undefined;

        if (!mangaId || !attrs || !title) {
          continue;
        }

        const entry = idToEntry.get(mangaId);

        if (!entry) {
          continue;
        }

        entry.title =
          stringField(title, "en") ??
          stringField(title, "ja-ro") ??
          stringField(title, "ja") ??
          Object.values(title).find(isString) ??
          "";
        const altTitles = attrs.altTitles;
        entry.altTitles = isJsonArray(altTitles)
          ? altTitles.filter(isJsonObject).flatMap((value) => Object.values(value).filter(isString))
          : [];
        const links = objectField(attrs, "links");
        const anilistId = links ? stringField(links, "al") : undefined;
        const malId = links ? stringField(links, "mal") : undefined;
        entry.anilistId = anilistId && /^\d+$/.test(anilistId) ? anilistId : undefined;
        entry.malId = malId && /^\d+$/.test(malId) ? malId : undefined;
      }

      fetched += mangaList.length;
      report?.progress(fetched, ids.length);

      yield* sleepEffect(MD_REQUEST_INTERVAL_MS);
    }

    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(paths(tmpDir).snapshot, JSON.stringify(entries, null, 2));
    report?.note(`Snapshot saved: ${entries.length} entries → ${paths(tmpDir).snapshot}`);

    return entries;
  });

export const phaseExport = (
  getMdToken: MdTokenProvider,
  tmpDir: string,
  report?: PhaseReporter,
): Promise<MdLibraryEntry[]> => runHost(phaseExportEffect(getMdToken, tmpDir, report));

export const loadProgress = (tmpDir: string): Map<string, number> | undefined => {
  const progress = readJsonFile(
    paths(tmpDir).progress,
    Schema.Record(Schema.String, Schema.Finite),
  );

  return progress === undefined ? undefined : new Map(Object.entries(progress));
};

const saveProgress = (tmpDir: string, progress: Map<string, number>): void => {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(paths(tmpDir).progress, JSON.stringify(Object.fromEntries(progress), null, 2));
};

// ---------- Phase B: match ----------

const searchAniListByTitleEffect = (
  token: string,
  search: string,
): Effect.Effect<readonly { id: number; titles: readonly string[] }[], CliEffectError> =>
  Effect.gen(function* () {
    const data = yield* aniListGraphqlEffect(
      "cli",
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

    const page = objectField(data, "Page");
    const media = page?.media;

    if (!page || !isJsonArray(media)) {
      return yield* cliError("AniList returned an invalid title search envelope");
    }

    return media.flatMap((value) => {
      if (!isJsonObject(value) || !isFiniteNumber(value.id)) {
        return [];
      }

      const title = objectField(value, "title");

      if (!title) {
        return [];
      }

      const synonyms = value.synonyms;

      return [
        {
          id: value.id,
          titles: [
            stringField(title, "userPreferred"),
            stringField(title, "english"),
            stringField(title, "romaji"),
            ...(isJsonArray(synonyms) ? synonyms.filter(isString) : []),
          ].filter((t): t is string => Boolean(t)),
        },
      ];
    });
  });

const phaseMatchEffect = (
  anilistToken: string,
  entries: readonly MdLibraryEntry[],
  tmpDir: string,
  report?: PhaseReporter,
  options?: { useCache?: boolean },
): Effect.Effect<MatchResult[], CliEffectError> =>
  Effect.gen(function* () {
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
        const malResult = yield* aniListGraphqlEffect(
          "cli",
          anilistToken,
          `query ($idMal: Int) {
            Media(idMal: $idMal, type: MANGA) { id }
          }`,
          { idMal: Number(entry.malId) },
        ).pipe(
          Effect.map((data) => {
            const media = objectField(data, "Media");
            const mediaId = media?.id;

            if (isFiniteNumber(mediaId) && mediaId > 0) {
              return {
                ...result,
                anilistId: String(mediaId),
                method: "mal-link" as const,
              } satisfies MatchResult;
            }

            return result;
          }),
          Effect.orElseSucceed(() => result),
        );

        result = malResult;
      }

      // 3) Title search across title + alt titles
      if (!result.anilistId) {
        const candidates = [entry.title, ...entry.altTitles].filter(Boolean);
        let foundExact = false;

        for (const candidate of candidates.slice(0, 6)) {
          if (foundExact) {
            break;
          }

          const titleResult = yield* searchAniListByTitleEffect(anilistToken, candidate).pipe(
            Effect.map((media) => {
              const normalizedCandidate = normalizeTitle(candidate);

              if (!normalizedCandidate) {
                return { result, foundExact: false };
              }

              for (const item of media) {
                for (const title of item.titles) {
                  if (normalizeTitle(title) === normalizedCandidate) {
                    return {
                      result: {
                        ...result,
                        anilistId: String(item.id),
                        method: "title-exact" as const,
                      } satisfies MatchResult,
                      foundExact: true,
                    };
                  }
                }
              }

              return { result, foundExact: false };
            }),
            Effect.orElseSucceed(() => ({ result, foundExact: false })),
          );

          result = titleResult.result;
          foundExact = titleResult.foundExact;
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
  });

export const phaseMatch = (
  anilistToken: string,
  entries: readonly MdLibraryEntry[],
  tmpDir: string,
  report?: PhaseReporter,
  options?: { useCache?: boolean },
): Promise<MatchResult[]> =>
  runHost(phaseMatchEffect(anilistToken, entries, tmpDir, report, options));

// ---------- Phase C: push ----------

/** Fetch read markers per entry and resolve their max chapter number. */
const collectProgressEffect = (
  getMdToken: MdTokenProvider,
  entries: readonly MdLibraryEntry[],
  report?: PhaseReporter,
  options?: { tmpDir?: string; useCache?: boolean },
): Effect.Effect<Map<string, number>, CliEffectError> =>
  Effect.gen(function* () {
    const progressByMdId = new Map<string, number>();

    const cachedProgress =
      options?.tmpDir && options.useCache ? loadProgress(options.tmpDir) : undefined;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (!entry) {
        continue;
      }

      const cached = cachedProgress?.get(entry.mangaDexId);

      if (cached !== undefined) {
        progressByMdId.set(entry.mangaDexId, cached);
      } else {
        yield* Effect.gen(function* () {
          const mdToken = yield* fromPromise(getMdToken).pipe(
            Effect.mapError((cause) => cliError(errorMessage(cause))),
          );

          const markerResponse = yield* fromPromise(() =>
            platformFetch(`${MD_API}/manga/${entry.mangaDexId}/read`, {
              headers: {
                authorization: `Bearer ${mdToken}`,
                accept: "application/json",
                "user-agent": USER_AGENT,
              },
            }),
          ).pipe(Effect.mapError((cause) => cliError(errorMessage(cause))));

          if (!markerResponse.ok) {
            return yield* cliError(`HTTP ${markerResponse.status}`);
          }

          const markerBody: unknown = yield* fromPromise(() => markerResponse.json()).pipe(
            Effect.mapError((cause) => cliError(errorMessage(cause))),
          );

          const markerData = isJsonObject(markerBody) ? markerBody.data : undefined;
          const chapterIds = isJsonArray(markerData) ? markerData.filter(isString) : [];

          if (chapterIds.length > 0) {
            let maxChapter = 0;

            for (let i = 0; i < chapterIds.length; i += 100) {
              const batch = chapterIds.slice(i, i + 100);
              const params = new URLSearchParams();
              params.set("limit", String(batch.length));

              for (const id of batch) {
                params.append("ids[]", id);
              }

              const chapters = yield* mdFetchEffect(mdToken, `/chapter?${params.toString()}`);

              for (const chapter of chapters) {
                const num = Number.parseFloat(stringField(chapter, "chapter") ?? "");

                if (Number.isFinite(num)) {
                  maxChapter = Math.max(maxChapter, num);
                }
              }

              yield* sleepEffect(MD_REQUEST_INTERVAL_MS);
            }

            if (maxChapter >= 1) {
              progressByMdId.set(entry.mangaDexId, Math.floor(maxChapter));
            }
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              report?.problem(`markers failed for ${entry.mangaDexId}: ${errorMessage(cause)}`);
            }),
          ),
        );
      }

      if (options?.tmpDir && (index + 1) % 25 === 0) {
        saveProgress(options.tmpDir, progressByMdId);
      }

      if ((index + 1) % 25 === 0 || index + 1 === entries.length) {
        report?.progress(index + 1, entries.length);
      }

      yield* sleepEffect(MD_REQUEST_INTERVAL_MS);
    }

    if (options?.tmpDir) {
      saveProgress(options.tmpDir, progressByMdId);
    }

    report?.note(`Got progress for ${progressByMdId.size}/${entries.length} entries.`);

    return progressByMdId;
  });

export const collectProgress = (
  getMdToken: MdTokenProvider,
  entries: readonly MdLibraryEntry[],
  report?: PhaseReporter,
  options?: { tmpDir?: string; useCache?: boolean },
): Promise<Map<string, number>> =>
  runHost(collectProgressEffect(getMdToken, entries, report, options));

/** Existing AniList progress (one bulk call): lets us never regress progress
 * that is already ahead of what MangaDex markers claim. */
const fetchExistingProgressEffect = (
  anilistToken: string,
): Effect.Effect<Map<string, number>, CliEffectError> =>
  Effect.gen(function* () {
    const viewer = yield* aniListGraphqlEffect("cli", anilistToken, `query { Viewer { id } }`);
    const viewerObject = objectField(viewer, "Viewer");
    const viewerId = viewerObject?.id;

    if (!isFiniteNumber(viewerId)) {
      return yield* cliError("Could not resolve AniList viewer id.");
    }

    const data = yield* aniListGraphqlEffect(
      "cli",
      anilistToken,
      `query ($userId: Int) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists { entries { mediaId progress } }
      }
    }`,
      { userId: viewerId },
    );

    const collection = data.MediaListCollection;

    if (collection === undefined || (collection !== null && !isJsonObject(collection))) {
      return yield* cliError("AniList returned an invalid progress envelope");
    }

    const lists = collection === null ? [] : collection.lists;

    if (lists === undefined || (lists !== null && !isJsonArray(lists))) {
      return yield* cliError("AniList returned an invalid progress envelope");
    }

    const existingProgress = new Map<string, number>();

    for (const list of isJsonArray(lists) ? lists : []) {
      if (!isJsonObject(list)) {
        return yield* cliError("AniList returned an invalid progress list");
      }

      const entries = list.entries;

      if (entries !== undefined && entries !== null && !isJsonArray(entries)) {
        return yield* cliError("AniList returned an invalid progress entries list");
      }

      for (const entry of isJsonArray(entries) ? entries : []) {
        if (!isJsonObject(entry)) {
          return yield* cliError("AniList returned an invalid progress entry");
        }

        const mediaId = entry.mediaId;
        const progress = entry.progress;

        if (isFiniteNumber(progress) && isFiniteNumber(mediaId)) {
          existingProgress.set(String(mediaId), progress);
        }
      }
    }

    return existingProgress;
  });

export const fetchExistingProgress = (anilistToken: string): Promise<Map<string, number>> =>
  runHost(fetchExistingProgressEffect(anilistToken));

/** Save matched entries to AniList; returns the push summary. */
const saveMatchesEffect = (
  anilistToken: string,
  matches: readonly MatchResult[],
  progressByMdId: Map<string, number>,
  existingProgress: Map<string, number> | undefined,
  options: { dryRun: boolean; progress: boolean },
  report?: PhaseReporter,
): Effect.Effect<{ done: number; failed: number; withProgress: number }, CliEffectError> =>
  Effect.gen(function* () {
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

      const pushResult = yield* Effect.gen(function* () {
        if (!options.dryRun) {
          yield* aniListGraphqlEffect(
            "cli",
            anilistToken,
            `mutation ($mediaId: Int!, $status: MediaListStatus${progress !== undefined ? ", $progress: Int" : ""}) {
            SaveMediaListEntry(mediaId: $mediaId, status: $status, private: true${progress !== undefined ? ", progress: $progress" : ""}) { id status private progress }
          }`,
            progress !== undefined
              ? { mediaId: Number(anilistId), status, progress }
              : { mediaId: Number(anilistId), status },
          );
        }

        return { ok: true as const, withProgress: progress !== undefined };
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            report?.problem(`${match.mangaDexId} -> ${anilistId} failed: ${errorMessage(cause)}`);

            return { ok: false as const, withProgress: false };
          }),
        ),
      );

      if (pushResult.ok) {
        done += 1;

        if (pushResult.withProgress) {
          withProgress += 1;
        }
      } else {
        failed += 1;
      }

      const current = done + failed;

      if (current % 5 === 0 || current === pushable.length) {
        report?.progress(current, pushable.length, [
          ["ok", done],
          ["fail", failed],
          ["prog", withProgress],
        ]);
      }
    }

    return { done, failed, withProgress };
  });

export const saveMatches = (
  anilistToken: string,
  matches: readonly MatchResult[],
  progressByMdId: Map<string, number>,
  existingProgress: Map<string, number> | undefined,
  options: { dryRun: boolean; progress: boolean },
  report?: PhaseReporter,
): Promise<{ done: number; failed: number; withProgress: number }> =>
  runHost(
    saveMatchesEffect(anilistToken, matches, progressByMdId, existingProgress, options, report),
  );
