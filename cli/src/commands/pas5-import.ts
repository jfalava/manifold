/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import {
  ReadingProgress,
  RegistryEntry,
  RegistryProvider,
  type LinkProviderInput,
} from "@manifold/contract";
import { errorMessage, isJsonObject, isString, stringField, type JsonValue } from "@manifold/json";
import { createAniListClient } from "@manifold/paperback-runtime/anilist";
import { aniListFetchTransport } from "@/anilist-drain";
import { apiCall, apiConfig, listRegistryRows, type RegistryRow } from "@/commands/toolbox";
import { cliError, epochMillisNow, jsonBodyString, newId } from "@/effect-kit";
import { resolveAniListToken } from "@/login/anilist";
import { parsePas5, type Pas5Entities } from "@/pas5";
import { LAST_READ_NEVER } from "@/pas5-model";
import { closeFrame, frameDetail, openFrame } from "@/ui";

/** Paperback's Manifold tracker source; its presence means reads already reach Manifold. */
const TRACKER_SOURCE_ID = "MANIFOLD";

/** The retired Manifold content source carries no native provider identity. */
const LEGACY_SOURCE_ID = "ManifoldSource";

const isRegistryProvider = Schema.is(RegistryProvider);

/**
 * Fields read from archived chapters and progress markers. Records missing any
 * of them are skipped and reported, never guessed.
 */
const ArchivedChapter = Schema.Struct({
  id: Schema.NonEmptyString,
  chapterId: Schema.NonEmptyString,
  chapNum: Schema.Finite,
  volume: Schema.optional(Schema.Finite),
  sourceManga: Schema.Struct({ id: Schema.NonEmptyString }),
});

type ArchivedChapter = Schema.Schema.Type<typeof ArchivedChapter>;

const CompletedMarker = Schema.Struct({
  completed: Schema.Literal(true),
  chapter: Schema.Struct({ id: Schema.NonEmptyString }),
});

const decodeChapter = Schema.decodeUnknownOption(ArchivedChapter);
const decodeCompletedMarker = Schema.decodeUnknownOption(CompletedMarker);

/** A `RecordReadInput` with only defined fields, so it also serializes into the report. */
type Pas5BackfillRead = {
  readonly eventId: string;
  readonly provider: RegistryProvider;
  readonly sourceMangaId: string;
  readonly sourceChapterId: string;
  readonly chapterKey: string;
  readonly chapterNumber: number;
  readonly volumeNumber?: number;
  readonly readAt?: number;
};

/** Furthest completed chapter of an untracked entry, recorded as a normal read. */
export type Pas5Backfill = {
  readonly read: Pas5BackfillRead;
  /** Registry progress before the backfill, when known. */
  readonly registryChapter?: number;
  readonly anilistId?: string;
};

interface ChapterIndex {
  /** Completed chapters by the `__SOURCE_MANGA_V5` record id they belong to. */
  readonly completedBySource: ReadonlyMap<string, readonly ArchivedChapter[]>;
  /** Completed markers whose chapter record is missing or lacks the fields above. */
  readonly unreadableBySource: ReadonlyMap<string, number>;
  readonly unreadableUnknownSource: number;
}

const coreDataToUnixMillis = (seconds: number): number => (seconds + 978_307_200) * 1000;

/** Chapters and markers are sharded across `__CHAPTER_V5-N` files in device exports. */
const indexCompletedChapters = (archive: Pas5Entities): ChapterIndex => {
  const chapters = new Map<string, JsonValue>();
  const markers: JsonValue[] = [];

  for (const [name, records] of Object.entries(archive)) {
    if (!isJsonObject(records)) {
      continue;
    }

    if (/^__CHAPTER_V5(?:-\d+)?$/.test(name)) {
      for (const [key, chapter] of Object.entries(records)) {
        const id = isJsonObject(chapter) && isString(chapter.id) ? chapter.id : key;
        chapters.set(id, chapter);
      }
    } else if (/^__CHAPTER_PROGRESS_MARKER_V5(?:-\d+)?$/.test(name)) {
      markers.push(...Object.values(records));
    }
  }

  const completedBySource = new Map<string, ArchivedChapter[]>();
  const unreadableBySource = new Map<string, number>();
  let unreadableUnknownSource = 0;

  for (const raw of markers) {
    const marker = decodeCompletedMarker(raw);

    if (Option.isNone(marker)) {
      continue;
    }

    const record = chapters.get(marker.value.chapter.id);
    const chapter = decodeChapter(record);

    if (Option.isSome(chapter)) {
      const list = completedBySource.get(chapter.value.sourceManga.id) ?? [];
      list.push(chapter.value);
      completedBySource.set(chapter.value.sourceManga.id, list);
      continue;
    }

    const sourceId =
      isJsonObject(record) && isJsonObject(record.sourceManga) && isString(record.sourceManga.id)
        ? record.sourceManga.id
        : undefined;

    if (sourceId === undefined) {
      unreadableUnknownSource += 1;
    } else {
      unreadableBySource.set(sourceId, (unreadableBySource.get(sourceId) ?? 0) + 1);
    }
  }

  return { completedBySource, unreadableBySource, unreadableUnknownSource };
};

export interface Pas5ImportPlan {
  readonly libraryId: string;
  entryId?: string;
  outcome: "ready" | "unchanged" | "unresolved" | "conflict" | "error";
  readonly canonicalIds: string[];
  readonly links: LinkProviderInput[];
  missingLinks: LinkProviderInput[];
  readonly titles: string[];
  readonly authors: string[];
  readonly artists: string[];
  readonly shareUrls: string[];
  readonly ignoredSourceIds: string[];
  readonly reasons: string[];
  /** Whether Paperback's Manifold tracker is attached, so reads already reach Manifold. */
  tracked: boolean;
  backfill?: Pas5Backfill;
  /** Why an untracked entry has no backfill. */
  backfillSkipped?: string;
}

const identityKey = (link: Pick<LinkProviderInput, "provider" | "externalId">): string =>
  `${link.provider}:${link.externalId}`;

const strings = (value: JsonValue | undefined): string[] =>
  isString(value) ? [value] : Array.isArray(value) ? value.filter(isString) : [];

const appendStrings = (target: string[], values: readonly string[]): void => {
  for (const value of values) {
    if (value.trim() && !target.includes(value)) {
      target.push(value);
    }
  }
};

const aniListIdOf = (row: RegistryRow): string | undefined =>
  row.provider === "anilist"
    ? row.providerId
    : row.providers.find((link) => link.provider === "anilist")?.externalId;

/**
 * Untracked reads never reached Manifold, so replay only the furthest
 * completed chapter: progress keeps the furthest chapter and never regresses,
 * so earlier chapters would change nothing.
 */
const planBackfill = (
  libraryId: string,
  lastRead: number | undefined,
  target: RegistryRow,
  nativeSources: ReadonlyMap<
    string,
    { readonly provider: RegistryProvider; readonly mangaId: string }
  >,
  index: ChapterIndex,
): Pas5Backfill | { readonly skipped: string } => {
  let best: { chapter: ArchivedChapter; provider: RegistryProvider; mangaId: string } | undefined;
  let unreadable = 0;

  for (const [sourceRecordId, source] of nativeSources) {
    unreadable += index.unreadableBySource.get(sourceRecordId) ?? 0;

    for (const chapter of index.completedBySource.get(sourceRecordId) ?? []) {
      if (!best || chapter.chapNum > best.chapter.chapNum) {
        best = { chapter, ...source };
      }
    }
  }

  const unreadableNote =
    unreadable > 0
      ? ` ${unreadable} completed chapter(s) were skipped: their chapter record lacks id, chapterId, chapNum or sourceManga.`
      : "";

  if (!best) {
    return {
      skipped: `No completed chapters in the export for this untracked entry.${unreadableNote}`,
    };
  }

  const registryChapter = target.progress?.chapterNumber;

  if (registryChapter !== undefined && registryChapter >= best.chapter.chapNum) {
    return {
      skipped: `Registry progress (ch ${registryChapter}) is already at or past the export's furthest completed chapter (ch ${best.chapter.chapNum}).${unreadableNote}`,
    };
  }

  const readAt =
    lastRead !== undefined && lastRead !== LAST_READ_NEVER
      ? coreDataToUnixMillis(lastRead)
      : undefined;

  const anilistId = aniListIdOf(target);

  return {
    read: {
      // Deterministic, so a repeated import is deduplicated by the API.
      eventId: `pas5:${libraryId}:${best.chapter.id}`,
      provider: best.provider,
      sourceMangaId: best.mangaId,
      sourceChapterId: best.chapter.chapterId,
      chapterKey: `${best.provider}:${best.chapter.chapterId}`,
      chapterNumber: best.chapter.chapNum,
      ...(best.chapter.volume !== undefined && { volumeNumber: best.chapter.volume }),
      ...(readAt !== undefined && { readAt }),
    },
    ...(registryChapter !== undefined && { registryChapter }),
    ...(anilistId !== undefined && { anilistId }),
  };
};

/** Read only library-attached records. Archive strings are evidence, never title matches. */
export const planPas5Import = (
  archive: Pas5Entities,
  rows: readonly RegistryRow[],
): Pas5ImportPlan[] => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chapterIndex = indexCompletedChapters(archive);
  const owners = new Map<string, Set<string>>();

  for (const row of rows) {
    const links = [
      ...row.providers,
      ...(row.provider === "anilist" || row.provider === "mal"
        ? [{ provider: row.provider, externalId: row.providerId }]
        : []),
    ];

    for (const link of links) {
      const key = `${link.provider}:${link.externalId}`;
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(row.id);
      owners.set(key, ids);
    }
  }

  const plans = Object.entries(archive.__LIBRARY_MANGA_V5).map(([libraryId, library]) => {
    const plan: Pas5ImportPlan = {
      libraryId,
      outcome: "unresolved",
      canonicalIds: [],
      links: [],
      missingLinks: [],
      titles: [],
      authors: [],
      artists: [],
      shareUrls: [],
      ignoredSourceIds: [],
      reasons: [],
      tracked: false,
    };

    // Native sources attached to this library entry, by source record id.
    const nativeSources = new Map<
      string,
      { readonly provider: RegistryProvider; readonly mangaId: string }
    >();

    try {
      if (library.id !== libraryId) {
        throw cliError("Malformed library identity.");
      }

      const observe = (provider: RegistryProvider, externalId: string, title?: string): void => {
        const previous = plan.links.find((link) => link.provider === provider);

        if (previous && previous.externalId !== externalId) {
          plan.reasons.push(`Multiple ${provider} identities attached to this library entry.`);
        } else if (!previous) {
          plan.links.push({ provider, externalId, ...(title && { title }) });
        }
      };

      for (const { id: sourceId } of library.attachedSources) {
        const source = archive.__SOURCE_MANGA_V5[sourceId];

        if (source?.id !== sourceId) {
          throw cliError(`Missing or malformed attached source ${sourceId}.`);
        }

        const tracker = source.sourceId === TRACKER_SOURCE_ID;
        // Providers are open: any Paperback source is its source ID lowercased.
        const nativeProvider = source.sourceId.toLowerCase();

        const native =
          !tracker && source.sourceId !== LEGACY_SOURCE_ID && isRegistryProvider(nativeProvider)
            ? nativeProvider
            : undefined;

        if (!native && !tracker) {
          appendStrings(plan.ignoredSourceIds, [source.sourceId]);
          continue;
        }

        if (tracker) {
          plan.tracked = true;
        }

        const info = archive.__MANGA_INFO_V5[source.mangaInfo.id];

        if (!info) {
          throw cliError(`Missing manga info for ${source.sourceId}.`);
        }

        appendStrings(plan.titles, [
          ...strings(info.primaryTitle),
          ...strings(info.secondaryTitles),
        ]);
        appendStrings(plan.authors, strings(info.author));
        appendStrings(plan.artists, strings(info.artist));
        appendStrings(plan.shareUrls, strings(info.shareUrl));

        if (native) {
          observe(native, source.mangaId, info.primaryTitle?.trim());
          nativeSources.set(source.id, { provider: native, mangaId: source.mangaId });
          continue;
        }

        const metadata = info.additionalInfo ?? {};
        const canonicalId = stringField(metadata, "Canonical ID");
        appendStrings(plan.canonicalIds, [source.mangaId]);

        if (canonicalId) {
          appendStrings(plan.canonicalIds, [canonicalId]);
        }

        const anilistId = stringField(metadata, "AniList ID");

        if (anilistId) {
          if (!/^[1-9]\d*$/.test(anilistId)) {
            throw cliError("Malformed AniList ID.");
          }

          observe("anilist", anilistId);
        }

        const provider = stringField(metadata, "Canonical provider");
        const providerId = stringField(metadata, "Canonical provider ID");

        if ((provider === "anilist" || provider === "mal") && providerId) {
          if (!/^[1-9]\d*$/.test(providerId)) {
            throw cliError(`Malformed ${provider} ID.`);
          }

          observe(provider, providerId);
        }
      }

      const targets = new Set<string>(plan.canonicalIds);

      for (const link of plan.links) {
        for (const owner of owners.get(identityKey(link)) ?? []) {
          targets.add(owner);
        }
      }

      if (targets.size > 1) {
        plan.reasons.push("Archive identities point to different registry entries.");
      }

      const targetId = [...targets][0];
      const target = targetId ? byId.get(targetId) : undefined;

      if (targetId && (!target || target.tombstoned)) {
        plan.reasons.push("Canonical target is missing or tombstoned; no fallback or recreation.");
      }

      if (target) {
        plan.entryId = target.id;

        for (const link of plan.links) {
          const existing = target.providers.find((item) => item.provider === link.provider);

          const canonical =
            target.provider === link.provider &&
            (target.provider === "anilist" || target.provider === "mal")
              ? target.providerId
              : undefined;

          if (
            (existing && existing.externalId !== link.externalId) ||
            (canonical && canonical !== link.externalId)
          ) {
            plan.reasons.push(
              `Existing ${link.provider} identity differs; replacement requires review.`,
            );
          } else if (!existing) {
            plan.missingLinks.push(link);
          }
        }
      }

      if (target && !plan.tracked && !plan.reasons.length) {
        const planned = planBackfill(
          libraryId,
          library.lastRead,
          target,
          nativeSources,
          chapterIndex,
        );

        if ("read" in planned) {
          plan.backfill = planned;
        } else {
          plan.backfillSkipped = planned.skipped;
        }
      }

      plan.outcome = plan.reasons.length
        ? "conflict"
        : !target
          ? "unresolved"
          : plan.missingLinks.length || plan.backfill
            ? "ready"
            : "unchanged";

      if (!target && !plan.reasons.length) {
        plan.reasons.push("No existing registry identity; titles are not identity proof.");
      }
    } catch (error) {
      plan.outcome = "error";
      plan.reasons.push(errorMessage(error));
    }

    return plan;
  });

  // Preflight the whole archive before any writes, independent of library order.
  const claims = new Map<string, { readonly value: string; readonly plan: Pas5ImportPlan }[]>();

  for (const plan of plans) {
    if (!plan.entryId || !["ready", "unchanged"].includes(plan.outcome)) {
      continue;
    }

    for (const link of plan.links) {
      const requirements: readonly (readonly [string, string])[] = [
        [`identity:${identityKey(link)}`, plan.entryId],
        [`binding:${plan.entryId}:${link.provider}`, link.externalId],
      ];

      for (const [key, value] of requirements) {
        const entries = claims.get(key) ?? [];
        entries.push({ value, plan });
        claims.set(key, entries);
      }
    }
  }

  for (const entries of claims.values()) {
    if (new Set(entries.map(({ value }) => value)).size < 2) {
      continue;
    }

    for (const { plan } of entries) {
      plan.outcome = "conflict";
      appendStrings(plan.reasons, ["Other library entries claim a different owner or edition."]);
    }
  }

  return plans;
};

export const pas5ImportCommand = Command.make("import-pas5", {
  input: Flag.String("input").pipe(
    Flag.withDescription("Paperback .pas5 export to read without modifying it."),
  ),
  apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
  report: Flag.String("report").pipe(Flag.optional),
  anilistToken: Flag.String("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription(
      "AniList token for backfilled progress. Falls back to login anilist / MANIFOLD_ANILIST_TOKEN.",
    ),
  ),
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Import attached Paperback provider identities into existing registry entries, flag library entries without the Manifold tracker and backfill their furthest completed chapter. Dry-run by default; never replaces links or list state.",
  ),
  Command.withHandler(({ input, apply, report, apiOrigin, apiToken, anilistToken }) =>
    Effect.tryPromise({
      try: async () => {
        const archive = await parsePas5(readFileSync(resolve(input)));
        const config = await apiConfig(apiOrigin, apiToken);
        const plans = planPas5Import(archive, await listRegistryRows(config));

        const path = resolve(
          Option.getOrUndefined(report) ??
            join(
              homedir(),
              ".manifold",
              "reports",
              `pas5-import-${epochMillisNow()}-${newId()}.jsonl`,
            ),
        );

        mkdirSync(dirname(path), { recursive: true });
        const file = openSync(path, "wx", 0o600);

        const record = (line: JsonValue): void => {
          writeSync(file, `${jsonBodyString(line)}\n`);
        };

        const counts = { ready: 0, applied: 0, unchanged: 0, unresolved: 0, conflict: 0, error: 0 };
        const written = new Set<string>();
        const untracked = plans.filter((plan) => !plan.tracked).length;
        let readsBackfilled = 0;
        let aniListPushed = 0;

        // Resolve the AniList token before any write so a missing login fails closed.
        const needsAniList =
          apply &&
          plans.some((plan) => plan.outcome === "ready" && plan.backfill?.anilistId !== undefined);

        const aniListToken = needsAniList
          ? await resolveAniListToken(Option.getOrUndefined(anilistToken))
          : undefined;

        if (needsAniList && !aniListToken) {
          throw cliError(
            "Backfilled reads need AniList: run login anilist, pass --anilist-token, or set MANIFOLD_ANILIST_TOKEN.",
          );
        }

        const aniList = createAniListClient(aniListFetchTransport);
        openFrame(`Paperback registry import → ${apply ? "apply" : "dry run"}`);
        frameDetail(`Report: ${path}`);

        try {
          record({
            event: "run",
            apply,
            input: resolve(input),
            evidence: "paperback-attachment",
            independentlyVerified: false,
          });

          for (const plan of plans) {
            let outcome: keyof typeof counts = plan.outcome;
            let error: string | undefined;

            if (apply && plan.outcome === "ready") {
              try {
                const { entryId } = plan;

                if (!entryId) {
                  throw cliError("Ready PAS5 plan has no registry entry id.");
                }

                for (const link of plan.missingLinks) {
                  const key = `${entryId}:${identityKey(link)}`;

                  if (written.has(key)) {
                    continue;
                  }

                  await apiCall(
                    config,
                    `/v1/entries/${encodeURIComponent(entryId)}/providers`,
                    "POST",
                    { ...link, onConflict: "reject" },
                    RegistryEntry,
                  );
                  written.add(key);
                  record({
                    event: "link",
                    entryId,
                    provider: link.provider,
                    externalId: link.externalId,
                  });
                }

                if (plan.backfill) {
                  const { read, anilistId } = plan.backfill;

                  const progress = await apiCall(
                    config,
                    `/v1/entries/${encodeURIComponent(entryId)}/read`,
                    "POST",
                    read,
                    ReadingProgress,
                  );

                  readsBackfilled += 1;
                  // Push AniList only when the registry actually advanced to this chapter.
                  const advanced = progress.chapterNumber === read.chapterNumber;
                  let pushed = false;

                  if (advanced && anilistId !== undefined && aniListToken !== undefined) {
                    pushed = await aniList.saveAniListProgress(
                      aniListToken,
                      anilistId,
                      read.chapterNumber,
                    );
                    aniListPushed += pushed ? 1 : 0;
                  }

                  record({
                    event: "read",
                    entryId,
                    ...read,
                    ...(progress.chapterNumber !== undefined && {
                      registryChapter: progress.chapterNumber,
                    }),
                    aniListPushed: pushed,
                  });
                }

                outcome = "applied";
              } catch (cause) {
                error = errorMessage(cause);
                outcome = "error";
              }
            }

            counts[outcome]++;
            record({ event: "entry", ...plan, outcome, ...(error && { error }) });

            const backfillNote = plan.backfill
              ? `; backfill ch ${plan.backfill.read.chapterNumber} from ${plan.backfill.read.provider}${plan.backfill.registryChapter === undefined ? "" : ` (registry ch ${plan.backfill.registryChapter})`}`
              : plan.backfillSkipped
                ? `; ${plan.backfillSkipped}`
                : "";

            frameDetail(
              `${outcome.toUpperCase()}${plan.tracked ? "" : " UNTRACKED"} ${plan.titles[0] ?? plan.libraryId}: ${plan.missingLinks.length} missing links${backfillNote}${error ? `; ${error}` : plan.reasons.length ? `; ${plan.reasons.join(" ")}` : ""}`,
            );
          }

          record({
            event: "summary",
            counts,
            linksWritten: written.size,
            untracked,
            readsBackfilled,
            aniListPushed,
          });
        } finally {
          closeSync(file);
          closeFrame(
            `${jsonBodyString(counts)}; ${written.size} links written; ${untracked} untracked; ${readsBackfilled} reads backfilled, ${aniListPushed} AniList pushes. Report: ${path}`,
            counts.error + counts.conflict > 0,
          );
        }

        if (counts.error || counts.conflict) {
          throw cliError(
            "PAS5 import has conflicts/errors; inspect the report. Earlier successful links, if any, remain saved.",
          );
        }
      },
      catch: (cause) => cliError(errorMessage(cause)),
    }),
  ),
);
