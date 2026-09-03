import { mkdir, readFile, writeFile } from "node:fs/promises";

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { ListrTask } from "listr2";
import {
  errorMessage,
  isJsonObject,
  numberField,
  objectField,
  stringField,
} from "@manifold/json";

import { createMangaDexTokenManager } from "@/mangadex-token";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import {
  createMangaDexClient,
  MANGADEX_CONTENT_RATINGS,
  type MangaDexReadingStatus,
} from "@manifold/mangadex";

interface StaleCtx extends RunContext {
  statuses: Record<string, MangaDexReadingStatus>;
  staleIds: readonly string[];
  titles: Readonly<Record<string, string>>;
}

const READ_SPACING_MS = 250;
const WRITE_SPACING_MS = 220;
const TITLE_BATCH_SIZE = 100;
const DETAIL_LINE_CAP = 40;
const TOKEN_CACHE_PATH = ".tmp/mangadex-token.json";
const STALE_CACHE_PATH = ".tmp/mangadex-stale-cache.json";
const PLAN_PATH = ".tmp/mangadex-stale-plan.json";
/** Cached upload timestamps older than this are ignored entirely. */
const STALE_CACHE_TTL_MS = 7 * 86_400_000;

interface StaleCacheFile {
  version: 1;
  savedAt: string;
  /** mangaId → latest known chapter upload (epoch ms). */
  entries: Record<string, { lastUploadAt: number }>;
}

const loadStaleCache = async (): Promise<{
  usable: boolean;
  savedAt: string | undefined;
  entries: Record<string, number>;
}> => {
  try {
    // SAFETY: stale-cache JSON is decoded via isJsonObject / field helpers below
    const raw: unknown = JSON.parse(await readFile(STALE_CACHE_PATH, "utf8"));
    if (!isJsonObject(raw) || raw.version !== 1) {
      return { usable: false, savedAt: undefined, entries: {} };
    }
    const savedAt = stringField(raw, "savedAt");
    if (savedAt === undefined) {return { usable: false, savedAt: undefined, entries: {} };}
    const age = Date.now() - Date.parse(savedAt);
    const entries: Record<string, number> = {};
    const entriesRaw = objectField(raw, "entries") ?? {};
    for (const [id, entry] of Object.entries(entriesRaw)) {
      if (!isJsonObject(entry)) {continue;}
      const lastUploadAt = numberField(entry, "lastUploadAt");
      if (lastUploadAt !== undefined) {
        entries[id] = lastUploadAt;
      }
    }
    return {
      usable: Number.isFinite(age) && age >= 0 && age < STALE_CACHE_TTL_MS,
      savedAt,
      entries,
    };
  } catch {
    return { usable: false, savedAt: undefined, entries: {} };
  }
};

const saveStaleCache = async (
  entries: Record<string, number>,
): Promise<void> => {
  const file: StaleCacheFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, lastUploadAt]) => [
        id,
        { lastUploadAt },
      ]),
    ),
  };
  await mkdir(".tmp", { recursive: true });
  await writeFile(STALE_CACHE_PATH, JSON.stringify(file));
};

interface StalePlanFile {
  version: 1;
  savedAt: string;
  olderThan: string;
  from: string[];
  to: string;
  staleIds: string[];
  titles: Record<string, string>;
}

const saveStalePlan = async (plan: StalePlanFile): Promise<void> => {
  await mkdir(".tmp", { recursive: true });
  await writeFile(PLAN_PATH, JSON.stringify(plan));
};

const loadStalePlan = async (): Promise<StalePlanFile | undefined> => {
  try {
    // SAFETY: parsed JSON matches StalePlanFile; for this trusted/test payload
    const raw = JSON.parse(await readFile(PLAN_PATH, "utf8")) as StalePlanFile;
    return raw.version === 1 && Array.isArray(raw.staleIds) ? raw : undefined;
  } catch {
    return undefined;
  }
};

const VALID_STATUSES: readonly MangaDexReadingStatus[] = [
  "reading",
  "on_hold",
  "plan_to_read",
  "dropped",
  "re_reading",
  "completed",
];

const DURATION_UNIT_MS = {
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
} as const;

/** Accepts "90", "90d", "12w", "6mo", "2y" (bare numbers mean days). */
export const parseDurationMs = (raw: string): number | undefined => {
  const match = /^(\d+)(d|w|mo|y)?$/i.exec(raw.trim());
  if (!match) {return undefined;}
  const unit = (match[2] ?? "d").toLowerCase();
  if (unit !== "d" && unit !== "w" && unit !== "mo" && unit !== "y") {
    return undefined;
  }
  return Number(match[1]) * DURATION_UNIT_MS[unit];
};

const optional = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.withDescription(description));

const parseList = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const staleStatusCommand = Command.make(
  "stale-status",
  {
    olderThan: Flag.string("older-than").pipe(
      Flag.withDefault("365d"),
      Flag.withDescription(
        "Cutoff since the last uploaded chapter, e.g. 90, 90d, 12w, 6mo, 2y.",
      ),
    ),
    to: Flag.string("to").pipe(
      Flag.withDefault("on_hold"),
      Flag.withDescription(
        `Target reading status for stale entries. One of: ${VALID_STATUSES.join(", ")}.`,
      ),
    ),
    from: Flag.string("from").pipe(
      Flag.withDefault("reading,re_reading"),
      Flag.withDescription(
        "Comma-separated current statuses eligible for the change.",
      ),
    ),
    apply: Flag.boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Write status changes to MangaDex. Default is a dry run."),
    ),
    usePlan: Flag.boolean("use-plan").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Skip scanning: reuse the stale list saved by the last run. Flags must match that run.",
      ),
    ),
    mangadexClientId: optional("mangadex-client-id", "Falls back to MANIFOLD_MANGADEX_CLIENT_ID."),
    mangadexClientSecret: optional("mangadex-client-secret", "Falls back to MANIFOLD_MANGADEX_CLIENT_SECRET."),
    mangadexUsername: optional("mangadex-username", "Falls back to MANIFOLD_MANGADEX_USERNAME."),
    mangadexPassword: optional("mangadex-password", "Falls back to MANIFOLD_MANGADEX_PASSWORD."),
  },
  ({
    olderThan,
    to,
    from,
    apply,
    usePlan,
    mangadexClientId,
    mangadexClientSecret,
    mangadexUsername,
    mangadexPassword,
  }) =>
    Effect.gen(function* () {
      const resolveValue = (
        flagValue: Option.Option<string>,
        ...names: readonly string[]
      ): string | undefined => {
        const direct = Option.getOrUndefined(flagValue);
        if (direct !== undefined) {return direct;}
        for (const name of names) {
          const value = process.env[name];
          if (value !== undefined && value !== "") {return value;}
        }
        return undefined;
      };

      const credentials = {
        clientId:
          resolveValue(mangadexClientId, "MANIFOLD_MANGADEX_CLIENT_ID") ?? "",
        clientSecret:
          resolveValue(mangadexClientSecret, "MANIFOLD_MANGADEX_CLIENT_SECRET") ?? "",
        username:
          resolveValue(mangadexUsername, "MANIFOLD_MANGADEX_USERNAME") ?? "",
        password:
          resolveValue(mangadexPassword, "MANIFOLD_MANGADEX_PASSWORD") ?? "",
      };
      const missing = Object.entries(credentials)
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Missing MangaDex credentials: ${missing.join(", ")}. Pass them as flags or set MANGADEX_*.`,
          ),
        );
      }

      const olderThanMs = parseDurationMs(olderThan);
      if (olderThanMs === undefined || olderThanMs <= 0) {
        return yield* Effect.fail(
          new Error(`Invalid --older-than "${olderThan}". Use forms like 90, 90d, 12w, 6mo, 2y.`),
        );
      }
      // SAFETY: value matches MangaDexReadingStatus)) at this call site
      if (!VALID_STATUSES.includes(to as MangaDexReadingStatus)) {
        return yield* Effect.fail(
          new Error(`Invalid --to "${to}". Choose one of: ${VALID_STATUSES.join(", ")}.`),
        );
      }
      const fromStatuses = parseList(from);
      const invalidFrom = fromStatuses.filter(
        // SAFETY: value matches MangaDexReadingStatus), at this call site
        (status) => !VALID_STATUSES.includes(status as MangaDexReadingStatus),
      );
      if (invalidFrom.length > 0) {
        return yield* Effect.fail(
          new Error(
            `Invalid --from values: ${invalidFrom.join(", ")}. Choose from: ${VALID_STATUSES.join(", ")}.`,
          ),
        );
      }
      const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
      // SAFETY: value matches MangaDexReadingStatus; at this call site
      const targetStatus = to as MangaDexReadingStatus;

      yield* Effect.tryPromise({
        try: async () => {
          openFrame(`Stale library prune → ${targetStatus} ${apply ? "(apply)" : "(dry run)"}`);
          frameDetail(`Chapters newer than ${cutoffIso} keep their status`);

          const manager = createMangaDexTokenManager({
            credentials,
            cachePath: TOKEN_CACHE_PATH,
          });
          let client = createMangaDexClient({
            accessToken: await manager.current(),
          });
          const refreshClient = async () => {
            client = createMangaDexClient({
              accessToken: await manager.current(),
            });
            return client;
          };

          const fetchStatusesTask: ListrTask<StaleCtx> = {
            title: "Fetch library statuses",
            task: async (ctx, task) => {
              ctx.statuses = await Effect.runPromise(client.readingStatuses());
              makePhaseReporter(task).note(
                `❖ ${Object.keys(ctx.statuses).length} library entries with a status.`,
              );
            },
            rendererOptions: { outputBar: Infinity },
          };
          const scanTask: ListrTask<StaleCtx> = {
            title: `Scan for uploads since ${olderThan}`,
              task: async (ctx, task) => {
                const reporter = makePhaseReporter(task);
                const candidates = Object.entries(ctx.statuses)
                  .filter(([, status]) => fromStatuses.includes(status))
                  .map(([id]) => id);
                if (candidates.length === 0) {
                  ctx.staleIds = [];
                  reporter.note("No entries match --from; nothing to do.");
                  return;
                }
                // MangaDex feed timestamps are second-precision UTC, no
                // timezone suffix allowed.
                const cutoff = cutoffIso.slice(0, 19);
                const cutoffMs = Date.now() - olderThanMs;

                const cached = await loadStaleCache();
                // Cache verdicts are only used when the live sweep cannot
                // finish; a completed sweep is always authoritative.
                const knownUploads: Record<string, number> = {};
                if (cached.usable) {
                  Object.assign(knownUploads, cached.entries);
                }

                // Phase 1: one paginated sweep of the followed-manga feed
                // since the cutoff; every manga that appears has fresh
                // chapters. All four content ratings must be passed or adult
                // titles are silently excluded from the feed.
                const fresh = new Set<string>();
                const seenUploads: Record<string, number> = {};
                let offset = 0;
                let requests = 1;
                let sweepComplete = false;
                try {
                  while (true) {
                    const page = await Effect.runPromise(
                      client.followedFeed({ publishedAtSince: cutoff, limit: 500, offset }),
                    );
                    for (const chapter of page.items) {
                      if (!fresh.has(chapter.mangaId)) {
                        fresh.add(chapter.mangaId);
                        // Pages are ordered newest-first, so the first hit
                        // per manga is its latest upload.
                        if (chapter.publishedAt !== undefined) {
                          seenUploads[chapter.mangaId] = chapter.publishedAt;
                        }
                      }
                    }
                    offset += page.items.length;
                    const total = page.total ?? offset;
                    reporter.progress(fresh.size, candidates.length, [
                      ["fresh", fresh.size],
                      ["pages", requests],
                    ] as const);
                    if (page.items.length === 0 || offset >= total) {break;}
                    requests += 1;
                    await sleep(READ_SPACING_MS);
                  }
                  sweepComplete = true;
                } catch (cause) {
                  reporter.problem(
                    `Feed sweep failed after ${requests} pages (${errorMessage(cause)}); finishing with per-title checks.`,
                  );
                }

                // Phase 2 (only needed when the sweep finished): the followed
                // list. A library title that is not followed never appears in
                // the feed above, so its freshness is unknown and needs an
                // individual check.
                const followed = new Set<string>();
                if (sweepComplete) {
                  offset = 0;
                  while (true) {
                    const page = await Effect.runPromise(
                      client.followedManga({ limit: 100, offset }),
                    );
                    for (const manga of page.items) {followed.add(manga.id);}
                    offset += page.items.length;
                    const total = page.total ?? offset;
                    reporter.progress(followed.size, candidates.length, [
                      ["followed", followed.size],
                    ] as const);
                    if (page.items.length === 0 || offset >= total) {break;}
                    await sleep(READ_SPACING_MS);
                  }
                }

                // Entries with no chapters at all never appear in feeds, so
                // they land here too — which is intended.
                const staleIds: string[] = [];
                const unverified: string[] = [];
                for (const id of candidates) {
                  if (fresh.has(id)) {continue;}
                  const knownAt = knownUploads[id];
                  // A recent cache entry can settle it without any request…
                  if (!sweepComplete && knownAt !== undefined) {
                    if (knownAt >= cutoffMs) {fresh.add(id);}
                    else {staleIds.push(id);}
                    continue;
                  }
                  // …otherwise follow-state decides after a complete sweep.
                  if (sweepComplete && followed.has(id)) {
                    staleIds.push(id);
                    continue;
                  }
                  unverified.push(id);
                }

                for (const id of unverified) {
                  const chapter = await Effect.runPromise(
                    client.latestChapterSince(id, cutoff),
                  );
                  requests += 1;
                  if (chapter?.publishedAt !== undefined) {
                    fresh.add(id);
                    seenUploads[id] = chapter.publishedAt;
                  } else {
                    staleIds.push(id);
                  }
                  reporter.progress(unverified.indexOf(id) + 1, unverified.length);
                  await sleep(READ_SPACING_MS);
                }

                ctx.staleIds = staleIds;
                reporter.note(
                  `❖ ${staleIds.length} stale of ${candidates.length} candidates ` +
                    `(${requests} requests scanned${cached.usable ? `, cache from ${cached.savedAt}` : ""}).`,
                );

                const mergedUploads: Record<string, number> = {};
                Object.assign(mergedUploads, knownUploads, seenUploads);
                await saveStaleCache(mergedUploads);

                const titles: Record<string, string> = {};
                for (let start = 0; start < staleIds.length; start += TITLE_BATCH_SIZE) {
                  const batch = staleIds.slice(start, start + TITLE_BATCH_SIZE);
                  const page = await Effect.runPromise(
                    client.listManga({
                      ids: batch,
                      contentRating: [...MANGADEX_CONTENT_RATINGS],
                      limit: 100,
                    }),
                  );
                  for (const manga of page.items) {titles[manga.id] = manga.title;}
                  await sleep(READ_SPACING_MS);
                }
                ctx.titles = titles;
                await saveStalePlan({
                  version: 1,
                  savedAt: new Date().toISOString(),
                  olderThan,
                  from: fromStatuses,
                  to: targetStatus,
                  staleIds,
                  titles,
                });
              },
              rendererOptions: { outputBar: 1, persistentOutput: true },
           };

          const loadPlanTask: ListrTask<StaleCtx> = {
            title: "Load saved plan",
            task: async (ctx, task) => {
              const reporter = makePhaseReporter(task);
              const plan = await loadStalePlan();
              if (!plan) {
                throw new Error(`No saved plan at ${PLAN_PATH}. Run a dry run first.`);
              }
              if (
                plan.to !== targetStatus ||
                plan.olderThan !== olderThan ||
                plan.from.join(",") !== fromStatuses.join(",")
              ) {
                throw new Error(
                  `Saved plan (${plan.olderThan}, ${plan.from.join(",")} → ${plan.to}) does not match these flags. Re-run a dry run first.`,
                );
              }
              ctx.staleIds = plan.staleIds;
              ctx.titles = plan.titles;
              reporter.note(
                `❖ ${plan.staleIds.length} entries from plan saved ${plan.savedAt}.`,
              );
            },
            rendererOptions: { outputBar: Infinity, persistentOutput: true },
          };

          const run = createRun<StaleCtx>([
            ...(usePlan ? [loadPlanTask] : [fetchStatusesTask, scanTask]),
            apply
              ? {
                  title: `Update stale entries to ${targetStatus}`,
                  task: async (ctx, task) => {
                    const reporter = makePhaseReporter(task);
                    // Token from the start of the run may have expired during the
                    // 8m scan; refresh once before the write burst.
                    await refreshClient();
                    const failures: string[] = [];
                    let done = 0;
                    for (const mangaId of ctx.staleIds) {
                      try {
                        await Effect.runPromise(client.updateReadingStatus(mangaId, targetStatus));
                      } catch (cause) {
                        const msg = errorMessage(cause);
                        const isAuth = isJsonObject(cause) && numberField(cause, "status") === 401;
                        if (isAuth) {
                          try {
                            await refreshClient();
                            await Effect.runPromise(client.updateReadingStatus(mangaId, targetStatus));
                            done += 1;
                            reporter.progress(done, ctx.staleIds.length, [
                              ["failed", failures.length],
                            ] as const);
                            if (done < ctx.staleIds.length) {await sleep(WRITE_SPACING_MS);}
                            continue;
                          } catch (retryCause) {
                            failures.push(
                              `${ctx.titles[mangaId] ?? mangaId}: ${errorMessage(retryCause)}`,
                            );
                          }
                        } else {
                          failures.push(`${ctx.titles[mangaId] ?? mangaId}: ${msg}`);
                        }
                      }
                      done += 1;
                      reporter.progress(done, ctx.staleIds.length, [
                        ["failed", failures.length],
                      ] as const);
                      if (done < ctx.staleIds.length) {await sleep(WRITE_SPACING_MS);}
                    }
                    for (const failure of failures.slice(0, DETAIL_LINE_CAP)) {
                      reporter.problem(failure);
                    }
                    if (failures.length > DETAIL_LINE_CAP) {
                      reporter.problem(`…and ${failures.length - DETAIL_LINE_CAP} more failures`);
                    }
                    reporter.note(`❖ ${done - failures.length}/${done} updated.`);
                    if (failures.length > 0) {process.exitCode = 1;}
                  },
                  rendererOptions: { outputBar: 1, persistentOutput: true },
                }
              : {
                  title: "Preview stale entries",
                  task: async (ctx, task) => {
                    const reporter = makePhaseReporter(task);
                    for (const mangaId of ctx.staleIds.slice(0, DETAIL_LINE_CAP)) {
                      reporter.detail(`❖ ${ctx.titles[mangaId] ?? "(untitled)"} [${mangaId}]`);
                    }
                    if (ctx.staleIds.length > DETAIL_LINE_CAP) {
                      reporter.detail(`❖ …and ${ctx.staleIds.length - DETAIL_LINE_CAP} more`);
                    }
                    reporter.note(
                      `❖ Dry run: would set ${ctx.staleIds.length} entries to ${targetStatus}. Re-run with --apply.`,
                    );
                  },
                  rendererOptions: { outputBar: Infinity, persistentOutput: true },
                },
          ]);

          try {
            await run.run();
            closeFrame(apply ? "Stale prune finished" : "Dry run finished");
          } catch (error) {
            abortFrame();
            throw error;
          }
        },
        catch: (cause) => new Error(errorMessage(cause)),
      }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
    }),
).pipe(
  Command.withDescription(
    "Set reading status for library entries whose latest chapter predates a cutoff.",
  ),
  Command.withAlias("prune-stale"),
);
