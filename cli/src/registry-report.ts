/** @effect-diagnostics nodeBuiltinImport:off */
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage, isJsonObject, isString, type JsonObject } from "@manifold/json";
import type { RegistryRow } from "@/commands/toolbox";
import { cliError, epochMillisNow, jsonBodyString, newId, parseJsonValue } from "@/effect-kit";

const completedOutcomes = new Set([
  "matched",
  "linked",
  "ambiguous",
  "unmatched",
  "unmapped",
  "not_found",
  "skipped",
  "deferred",
]);

const fingerprint = (row: RegistryRow): string =>
  jsonBodyString({
    provider: row.provider,
    providerId: row.providerId,
    title: row.title,
    status: row.state?.status ?? null,
    providers: row.providers
      .map((link) => [link.provider, link.externalId])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });

/** Reports are append-only checkpoints, not instructions or cached writes. */
export const openRegistryReport = (
  provider: string,
  apply: boolean,
  settings: JsonObject,
  outputPath?: string,
  resumePath?: string,
) => {
  const previous = new Map<string, JsonObject>();
  const catalog = new Map<string, JsonObject>();
  if (resumePath) {
    const lines = readFileSync(resolve(resumePath), "utf8").split("\n");
    let header: JsonObject | undefined;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) {
        continue;
      }
      let value: JsonObject;
      try {
        const parsed = parseJsonValue(line);
        if (!isJsonObject(parsed)) {
          throw cliError("Expected a JSON object.");
        }
        value = parsed;
      } catch (error) {
        // An interrupted final write may be incomplete. Never ignore earlier corruption.
        if (index === lines.length - 1) {
          break;
        }
        throw cliError(`Invalid resume report line ${index + 1}: ${errorMessage(error)}`);
      }
      if (value.event === "run") {
        if (header) {
          throw cliError("Resume report contains multiple runs.");
        }
        header = value;
      } else if (
        (value.event === "entry" || value.event === "checkpoint") &&
        isString(value.entryId)
      ) {
        if (!header) {
          throw cliError("Resume report entries precede the run header.");
        }
        previous.set(value.entryId, {
          ...value,
          applied: value.applied ?? header.apply,
          legacy: header.reportVersion === undefined || value.legacy === true,
        });
      } else if (value.event === "catalog" && isString(value.kind) && isString(value.key)) {
        catalog.set(jsonBodyString([value.origin ?? null, value.kind, value.key]), value);
      }
    }
    if (!header) {
      throw cliError("Resume report has no run header.");
    }
    // Recognize the original provider reports so existing long sweeps can resume too.
    const recordedProvider =
      header.provider ??
      (header.identity === "exact title + author/artist; duplicate slugs stay ambiguous"
        ? "manganato"
        : Array.isArray(header.excludedSources) && header.excludedSources.includes("MangaDex")
          ? "kagane"
          : isString(header.origin) &&
              /^https:\/\/(?:xcomic\.(?:me|net)|yona\.to|comik\.to)$/.test(header.origin)
            ? "xcomic"
            : undefined);
    if (recordedProvider !== provider) {
      throw cliError(`Resume report is not a ${provider} report.`);
    }
    if (header.reportVersion !== undefined && header.reportVersion !== 1) {
      throw cliError("Unsupported resume report version.");
    }
    const recordedSettings = isJsonObject(header.settings) ? header.settings : header;
    for (const [key, value] of Object.entries(settings)) {
      // Old reports did not record the API origin; all new reports do.
      const oldValue = recordedSettings[key] ?? (key === "auditExisting" ? false : undefined);
      if (
        oldValue === undefined &&
        ["apiOrigin", "anilistAliases"].includes(key) &&
        header.reportVersion === undefined
      ) {
        continue;
      }
      if (jsonBodyString(oldValue ?? null) !== jsonBodyString(value)) {
        throw cliError(
          `Resume report ${key} differs; keep matching settings or start a fresh run.`,
        );
      }
    }
  }

  const terminal = (entry: JsonObject): boolean =>
    entry.retryable !== true &&
    isString(entry.outcome) &&
    completedOutcomes.has(entry.outcome) &&
    // Existing bindings are filtered by the commands. A removed applied binding must retry.
    (!["matched", "linked"].includes(entry.outcome) || (!apply && entry.applied === false));

  const path = resolve(
    outputPath ??
      join(homedir(), ".manifold", "reports", `${provider}-${epochMillisNow()}-${newId()}.jsonl`),
  );
  if (resumePath && path === resolve(resumePath)) {
    throw cliError("--report must be a new file, not the --resume input.");
  }
  mkdirSync(dirname(path), { recursive: true });
  const file = openSync(path, "wx", 0o600);
  const record = (line: JsonObject): void => {
    writeSync(file, `${jsonBodyString(line)}\n`);
  };
  try {
    record({
      ...settings,
      event: "run",
      provider,
      reportVersion: 1,
      apply,
      settings,
      ...(resumePath && { resume: resolve(resumePath) }),
    });
    // Carry all latest outcomes, including failures, so chains do not resurrect old successes.
    for (const entry of previous.values()) {
      record({
        event: "checkpoint",
        entryId: entry.entryId!,
        title: entry.title ?? null,
        outcome: entry.outcome ?? null,
        fingerprint: entry.fingerprint ?? null,
        applied: entry.applied === true,
        retryable: entry.retryable === true,
        legacy: entry.legacy === true,
        retryWhen: entry.retryWhen ?? null,
        searchPolicy: entry.searchPolicy ?? null,
        selectionPolicy: entry.selectionPolicy ?? null,
        candidates: entry.candidates ?? null,
        chapterReference: entry.chapterReference ?? null,
        candidateIds: entry.candidateIds ?? null,
        deferredReason: entry.deferredReason ?? null,
        discovery: entry.discovery ?? null,
        titles: entry.titles ?? null,
        authors: entry.authors ?? null,
        queries: entry.queries ?? null,
        cappedQueries: entry.cappedQueries ?? null,
        selectedId: entry.selectedId ?? null,
        selection: entry.selection ?? null,
        acceptedRecommendation: entry.acceptedRecommendation === true,
        recommendation: entry.recommendation ?? null,
        note: entry.note ?? null,
      });
    }
    for (const entry of catalog.values()) {
      record(entry);
    }
  } catch (error) {
    closeSync(file);
    throw error;
  }
  const checkpoint = (row: RegistryRow): JsonObject | undefined => {
    const entry = previous.get(row.id);
    return entry &&
      (isString(entry.fingerprint)
        ? entry.fingerprint === fingerprint(row)
        : entry.legacy === true && entry.title === row.title)
      ? entry
      : undefined;
  };
  return {
    path,
    record,
    catalog: [...catalog.values()],
    checkpoint,
    // Candidate hints survive status/title changes on the same registry entry.
    // Callers must revalidate them; this never reuses eligibility or a selected link.
    candidateIds: (row: RegistryRow): readonly string[] => {
      const entry = previous.get(row.id);
      const ids = new Set<string>();
      for (const id of Array.isArray(entry?.candidateIds) ? entry.candidateIds : []) {
        if (isString(id)) {
          ids.add(id);
        }
      }
      for (const candidate of Array.isArray(entry?.candidates) ? entry.candidates : []) {
        if (isJsonObject(candidate) && isString(candidate.id)) {
          ids.add(candidate.id);
        }
      }
      return [...ids];
    },
    skip: (row: RegistryRow, retryWhen: JsonObject = {}): boolean => {
      const entry = checkpoint(row);
      if (!entry) {
        return false;
      }
      return (
        terminal(entry) &&
        (entry.outcome !== "ambiguous" ||
          retryWhen.selectionPolicy === undefined ||
          entry.selectionPolicy === retryWhen.selectionPolicy) &&
        (entry.outcome !== "ambiguous" ||
          retryWhen.acceptRecommendations !== true ||
          (isJsonObject(entry.retryWhen) && entry.retryWhen.acceptRecommendations === true)) &&
        // A new discovery policy can revisit old misses, while old proven ambiguities stay skipped.
        (entry.outcome === "ambiguous" ||
          retryWhen.searchPolicy === undefined ||
          (entry.searchPolicy === undefined || entry.searchPolicy === null
            ? entry.outcome !== "unmatched"
            : entry.searchPolicy === retryWhen.searchPolicy)) &&
        (entry.outcome !== "deferred" ||
          jsonBodyString(entry.retryWhen ?? null) === jsonBodyString(retryWhen))
      );
    },
    entry: (row: RegistryRow, line: JsonObject): void =>
      record({
        ...line,
        event: "entry",
        entryId: row.id,
        title: row.title,
        fingerprint: fingerprint(row),
        applied: apply,
      }),
    close: (): void => closeSync(file),
  };
};
