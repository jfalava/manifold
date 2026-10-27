/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics nodeBuiltinImport:off */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { RegistryEntry, type LinkProviderInput, type RegistryProvider } from "@manifold/contract";
import {
  arrayField,
  errorMessage,
  isFiniteNumber,
  isJsonObject,
  isString,
  objectField,
  stringField,
  type JsonValue,
} from "@manifold/json";
import { UPSTREAM_SOURCES } from "@/commands/pas5";
import { apiCall, apiConfig, listRegistryRows, type RegistryRow } from "@/commands/toolbox";
import { cliError, epochMillisNow, jsonBodyString, newId } from "@/effect-kit";
import { parsePas5, type Pas5Entities } from "@/pas5";
import { closeFrame, frameDetail, openFrame } from "@/ui";

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

/** Read only library-attached records. Archive strings are evidence, never title matches. */
export const planPas5Import = (
  archive: Pas5Entities,
  rows: readonly RegistryRow[],
): Pas5ImportPlan[] => {
  if (
    !isJsonObject(archive) ||
    !isJsonObject(archive.__LIBRARY_MANGA_V5) ||
    !isJsonObject(archive.__SOURCE_MANGA_V5) ||
    !isJsonObject(archive.__MANGA_INFO_V5)
  ) {
    throw cliError("PAS5 requires library, source and manga-info entity dictionaries.");
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
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

  const plans = Object.entries(archive.__LIBRARY_MANGA_V5).map(([libraryId, raw]) => {
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
    };
    try {
      if (!isJsonObject(raw) || stringField(raw, "id") !== libraryId) {
        throw cliError("Malformed library identity.");
      }
      const refs = arrayField(raw, "attachedSources");
      if (!refs) {
        throw cliError("Missing library attachedSources.");
      }
      const observe = (provider: RegistryProvider, externalId: string, title?: string): void => {
        const previous = plan.links.find((link) => link.provider === provider);
        if (previous && previous.externalId !== externalId) {
          plan.reasons.push(`Multiple ${provider} identities attached to this library entry.`);
        } else if (!previous) {
          plan.links.push({ provider, externalId, ...(title && { title }) });
        }
      };
      for (const ref of refs) {
        if (!isJsonObject(ref) || !stringField(ref, "id") || ref.type !== "__SOURCE_MANGA_V5") {
          throw cliError("Malformed source reference.");
        }
        const sourceId = stringField(ref, "id")!;
        const source = archive.__SOURCE_MANGA_V5[sourceId];
        if (
          !isJsonObject(source) ||
          source.id !== sourceId ||
          !stringField(source, "sourceId") ||
          !stringField(source, "mangaId") ||
          stringField(source, "mangaId") !== source.mangaId
        ) {
          throw cliError(`Missing or malformed attached source ${sourceId}.`);
        }
        const native = UPSTREAM_SOURCES.find((item) => item.sourceId === source.sourceId);
        const tracker = source.sourceId === "MANIFOLD";
        if (!native && !tracker) {
          appendStrings(plan.ignoredSourceIds, [source.sourceId]);
          continue;
        }
        if (
          !isJsonObject(source.mangaInfo) ||
          source.mangaInfo.type !== "__MANGA_INFO_V5" ||
          !(isString(source.mangaInfo.id) || isFiniteNumber(source.mangaInfo.id))
        ) {
          throw cliError(`Malformed manga-info reference for ${source.sourceId}.`);
        }
        const info = archive.__MANGA_INFO_V5[String(source.mangaInfo.id)];
        if (!isJsonObject(info)) {
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
          observe(native.provider, source.mangaId, stringField(info, "primaryTitle"));
          continue;
        }
        const metadata = objectField(info, "additionalInfo") ?? {};
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
      plan.outcome = plan.reasons.length
        ? "conflict"
        : !target
          ? "unresolved"
          : plan.missingLinks.length
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
  apiOrigin: Flag.String("api-origin").pipe(Flag.optional),
  apiToken: Flag.String("api-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Import attached Paperback provider identities into existing registry entries. Dry-run by default; never replaces links or list state.",
  ),
  Command.withHandler(({ input, apply, report, apiOrigin, apiToken }) =>
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
                for (const link of plan.missingLinks) {
                  const key = `${plan.entryId}:${identityKey(link)}`;
                  if (written.has(key)) {
                    continue;
                  }
                  await apiCall(
                    config,
                    `/v1/entries/${encodeURIComponent(plan.entryId!)}/providers`,
                    "POST",
                    { ...link, onConflict: "reject" },
                    RegistryEntry,
                  );
                  written.add(key);
                  record({
                    event: "link",
                    entryId: plan.entryId!,
                    provider: link.provider,
                    externalId: link.externalId,
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
            frameDetail(
              `${outcome.toUpperCase()} ${plan.titles[0] ?? plan.libraryId}: ${plan.missingLinks.length} missing links${error ? `; ${error}` : plan.reasons.length ? `; ${plan.reasons.join(" ")}` : ""}`,
            );
          }
          record({ event: "summary", counts, linksWritten: written.size });
        } finally {
          closeSync(file);
          closeFrame(
            `${jsonBodyString(counts)}; ${written.size} links written. Report: ${path}`,
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
