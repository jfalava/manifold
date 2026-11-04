/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics globalJsonInEffect:off */
/** @effect-diagnostics tryCatchInEffectGen:off */
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type { ListrTask } from "listr2";
import { errorMessage, isJsonObject, numberField, objectField, stringField } from "@manifold/json";
import { toJsonText } from "@manifold/json/text";

import {
  fetchFollowedMangaIds,
  fetchMangaDexTitles,
  mangadexCredentialFlags,
  openMangaDexSession,
  requireMangaDexCredentials,
  runMangaDexWrites,
} from "@/mangadex-session";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  type RunContext,
} from "@/ui";
import { MangaDexReadingStatus } from "@manifold/mangadex";
import { cliError, epochMillisNow, fromPromise, runHost, sleepPromise } from "@/effect-kit";

interface StaleCtx extends RunContext {
  statuses: Record<string, MangaDexReadingStatus>;
  staleIds: readonly string[];
  titles: Readonly<Record<string, string>>;
}

const READ_SPACING_MS = 250;
const WRITE_SPACING_MS = 220;
const DETAIL_LINE_CAP = 40;
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

const loadStaleCache = (): Promise<{
  usable: boolean;
  savedAt: string | undefined;
  entries: Record<string, number>;
}> =>
  runHost(
    Effect.gen(function* () {
      const text = yield* fromPromise(() => readFile(STALE_CACHE_PATH, "utf8")).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (text === undefined) {
        return { usable: false, savedAt: undefined, entries: {} };
      }

      let raw: unknown;

      try {
        raw = JSON.parse(text);
      } catch {
        return { usable: false, savedAt: undefined, entries: {} };
      }

      if (!isJsonObject(raw) || raw.version !== 1) {
        return { usable: false, savedAt: undefined, entries: {} };
      }

      const savedAt = stringField(raw, "savedAt");

      if (savedAt === undefined) {
        return { usable: false, savedAt: undefined, entries: {} };
      }

      const age = epochMillisNow() - Date.parse(savedAt);
      const entries: Record<string, number> = {};
      const entriesRaw = objectField(raw, "entries") ?? {};

      for (const [id, entry] of Object.entries(entriesRaw)) {
        if (!isJsonObject(entry)) {
          continue;
        }

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
    }),
  );

const saveStaleCache = (entries: Record<string, number>): Promise<void> =>
  runHost(
    Effect.gen(function* () {
      const file: StaleCacheFile = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries: Object.fromEntries(
          Object.entries(entries).map(([id, lastUploadAt]) => [id, { lastUploadAt }]),
        ),
      };

      yield* fromPromise(() => mkdir(".tmp", { recursive: true }));
      yield* fromPromise(() => writeFile(STALE_CACHE_PATH, toJsonText(file)));
    }),
  );

const StalePlanFile = Schema.Struct({
  version: Schema.Literal(1),
  savedAt: Schema.String,
  olderThan: Schema.String,
  from: Schema.Array(Schema.String),
  to: Schema.String,
  staleIds: Schema.Array(Schema.String),
  titles: Schema.Record(Schema.String, Schema.String),
});

type StalePlanFile = typeof StalePlanFile.Type;

const decodeStalePlan = Schema.decodeOption(Schema.fromJsonString(StalePlanFile));

const saveStalePlan = (plan: StalePlanFile): Promise<void> =>
  runHost(
    Effect.gen(function* () {
      yield* fromPromise(() => mkdir(".tmp", { recursive: true }));
      yield* fromPromise(() => writeFile(PLAN_PATH, toJsonText(plan)));
    }),
  );

const loadStalePlan = (): Promise<StalePlanFile | undefined> =>
  runHost(
    Effect.gen(function* () {
      const text = yield* fromPromise(() => readFile(PLAN_PATH, "utf8")).pipe(
        Effect.orElseSucceed(() => undefined),
      );

      if (text === undefined) {
        return undefined;
      }

      return Option.getOrUndefined(decodeStalePlan(text));
    }),
  );

const VALID_STATUSES = MangaDexReadingStatus.literals;
const isReadingStatus = Schema.is(MangaDexReadingStatus);

const DURATION_UNIT_MS = {
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
} as const;

/** Accepts "90", "90d", "12w", "6mo", "2y" (bare numbers mean days). */
export const parseDurationMs = (raw: string): number | undefined => {
  const match = /^(\d+)(d|w|mo|y)?$/i.exec(raw.trim());

  if (!match) {
    return undefined;
  }

  const unit = (match[2] ?? "d").toLowerCase();

  if (unit !== "d" && unit !== "w" && unit !== "mo" && unit !== "y") {
    return undefined;
  }

  return Number(match[1]) * DURATION_UNIT_MS[unit];
};

const parseList = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

const sleep = sleepPromise;

export const staleStatusCommand = Command.make(
  "stale-status",
  {
    olderThan: Flag.String("older-than").pipe(
      Flag.withDefault("365d"),
      Flag.withDescription("Cutoff since the last uploaded chapter, e.g. 90, 90d, 12w, 6mo, 2y."),
    ),
    to: Flag.String("to").pipe(
      Flag.withDefault("on_hold"),
      Flag.withDescription(
        `Target reading status for stale entries. One of: ${VALID_STATUSES.join(", ")}.`,
      ),
    ),
    from: Flag.String("from").pipe(
      Flag.withDefault("reading,re_reading"),
      Flag.withDescription("Comma-separated current statuses eligible for the change."),
    ),
    apply: Flag.Boolean("apply").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Write status changes to MangaDex. Default is a dry run."),
    ),
    usePlan: Flag.Boolean("use-plan").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Skip scanning: reuse the stale list saved by the last run. Flags must match that run.",
      ),
    ),
    ...mangadexCredentialFlags,
  },
  ({ olderThan, to, from, apply, usePlan, ...credentialFlags }) =>
    Effect.gen(function* () {
      const credentials = yield* requireMangaDexCredentials(credentialFlags);

      const olderThanMs = parseDurationMs(olderThan);

      if (olderThanMs === undefined || olderThanMs <= 0) {
        return yield* cliError(
          `Invalid --older-than "${olderThan}". Use forms like 90, 90d, 12w, 6mo, 2y.`,
        );
      }

      if (!isReadingStatus(to)) {
        return yield* cliError(
          `Invalid --to "${to}". Choose one of: ${VALID_STATUSES.join(", ")}.`,
        );
      }

      const fromStatuses = parseList(from);

      const invalidFrom = fromStatuses.filter((status) => !isReadingStatus(status));

      if (invalidFrom.length > 0) {
        return yield* cliError(
          `Invalid --from values: ${invalidFrom.join(", ")}. Choose from: ${VALID_STATUSES.join(", ")}.`,
        );
      }

      const cutoffIso = new Date(epochMillisNow() - olderThanMs).toISOString();
      const targetStatus = to;

      yield* Effect.tryPromise({
        try: async () => {
          openFrame(`Stale library prune → ${targetStatus} ${apply ? "(apply)" : "(dry run)"}`);
          frameDetail(`Chapters newer than ${cutoffIso} keep their status`);

          const session = await openMangaDexSession(credentials);

          const fetchStatusesTask: ListrTask<StaleCtx> = {
            title: "Fetch library statuses",
            task: async (ctx, task) => {
              ctx.statuses = await runHost(session.client().readingStatuses());
              makePhaseReporter(task).note(
                `${Object.keys(ctx.statuses).length} library entries with a status.`,
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
              const cutoffMs = epochMillisNow() - olderThanMs;

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
                  const page = await runHost(
                    session.client().followedFeed({ publishedAtSince: cutoff, limit: 500, offset }),
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

                  if (page.items.length === 0 || offset >= total) {
                    break;
                  }

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
              const followed = sweepComplete
                ? await fetchFollowedMangaIds(session.client(), READ_SPACING_MS, (count) =>
                    reporter.progress(count, candidates.length, [["followed", count]]),
                  )
                : new Set<string>();

              // Entries with no chapters at all never appear in feeds, so
              // they land here too — which is intended.
              const staleIds: string[] = [];
              const unverified: string[] = [];

              for (const id of candidates) {
                if (fresh.has(id)) {
                  continue;
                }

                const knownAt = knownUploads[id];

                // A recent cache entry can settle it without any request…
                if (!sweepComplete && knownAt !== undefined) {
                  if (knownAt >= cutoffMs) {
                    fresh.add(id);
                  } else {
                    staleIds.push(id);
                  }

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
                const chapter = await runHost(session.client().latestChapterSince(id, cutoff));
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
                `${staleIds.length} stale of ${candidates.length} candidates ` +
                  `(${requests} requests scanned${cached.usable ? `, cache from ${cached.savedAt}` : ""}).`,
              );

              const mergedUploads: Record<string, number> = {};
              Object.assign(mergedUploads, knownUploads, seenUploads);
              await saveStaleCache(mergedUploads);

              const titles = await fetchMangaDexTitles(session.client(), staleIds, READ_SPACING_MS);

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
                throw cliError(`No saved plan at ${PLAN_PATH}. Run a dry run first.`);
              }

              if (
                plan.to !== targetStatus ||
                plan.olderThan !== olderThan ||
                plan.from.join(",") !== fromStatuses.join(",")
              ) {
                throw cliError(
                  `Saved plan (${plan.olderThan}, ${plan.from.join(",")} → ${plan.to}) does not match these flags. Re-run a dry run first.`,
                );
              }

              ctx.staleIds = plan.staleIds;
              ctx.titles = plan.titles;
              reporter.note(`${plan.staleIds.length} entries from plan saved ${plan.savedAt}.`);
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
                    await runMangaDexWrites(session, reporter, {
                      ids: ctx.staleIds,
                      titles: ctx.titles,
                      write: (client, mangaId) => client.updateReadingStatus(mangaId, targetStatus),
                      verb: "updated",
                      spacingMs: WRITE_SPACING_MS,
                      listWritten: false,
                    });
                  },
                  rendererOptions: { outputBar: 1, persistentOutput: true },
                }
              : {
                  title: "Preview stale entries",
                  task: async (ctx, task) => {
                    const reporter = makePhaseReporter(task);

                    for (const mangaId of ctx.staleIds.slice(0, DETAIL_LINE_CAP)) {
                      reporter.note(`${ctx.titles[mangaId] ?? "(untitled)"} [${mangaId}]`);
                    }

                    if (ctx.staleIds.length > DETAIL_LINE_CAP) {
                      reporter.note(`…and ${ctx.staleIds.length - DETAIL_LINE_CAP} more`);
                    }

                    reporter.note(
                      `Dry run: would set ${ctx.staleIds.length} entries to ${targetStatus}. Re-run with --apply.`,
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
        catch: (cause) => cliError(errorMessage(cause)),
      }).pipe(Effect.onError(() => Effect.sync(abortFrame)));
    }),
).pipe(
  Command.withDescription(
    "Set reading status for library entries whose latest chapter predates a cutoff.",
  ),
);
