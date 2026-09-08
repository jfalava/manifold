import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { createAniListSource } from "@manifold/canonical/sources";
import { RegistryEntry, RegistryListResponse, type RegistryListEntry } from "@manifold/contract";
import { errorMessage, manifoldUserAgent } from "@manifold/json";
import { apiCall, apiConfig } from "@/commands/toolbox";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";

export const malPrefillCommand = Command.make("mal", {
  apply: Flag.boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Persist verified MAL links. Default: read-only audit."),
  ),
  limit: Flag.integer("limit").pipe(
    Flag.optional,
    Flag.withDescription("Maximum missing links to look up. Default: all."),
  ),
  delay: Flag.integer("delay").pipe(
    Flag.withDefault(1500),
    Flag.withDescription("Milliseconds between AniList lookups. Default: 1500."),
  ),
  apiOrigin: Flag.string("api-origin").pipe(Flag.optional),
  apiToken: Flag.string("api-token").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Audit and backfill MAL links from AniList idMal. Never changes list state or title-matches."),
  Command.withHandler(({ apply, limit, delay, apiOrigin, apiToken }) => Effect.tryPromise({
    try: async () => {
      const maximum = Option.getOrUndefined(limit);
      if (delay < 0 || (maximum !== undefined && maximum < 0)) {
        throw new Error("--delay and --limit must be non-negative");
      }
      const config = apiConfig(apiOrigin, apiToken);
      const source = createAniListSource({
        userAgent: manifoldUserAgent("cli"),
        fetcher: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
      });
      openFrame(`MAL registry links (${apply ? "apply" : "dry run"})`);
      try {
        const rows: RegistryListEntry[] = [];
        const pageSize = 5000;
        let offset = 0;
        for (;;) {
          const page = await apiCall(config, `/v1/registry?limit=${pageSize}&offset=${offset}`, "GET", undefined, RegistryListResponse);
          rows.push(...page.entries.filter((row) => !row.tombstoned));
          offset += page.entries.length;
          if (page.entries.length < pageSize) {break;}
        }
        const missing = rows.filter((row) => !row.providers.some((link) => link.provider === "mal"));
        const eligible = missing.filter((row) => row.providers.some((link) => link.provider === "anilist"));
        const selected = maximum === undefined ? eligible : eligible.slice(0, maximum);
        const owners = new Map(rows.flatMap((row) => row.providers
          .filter((link) => link.provider === "mal")
          .map((link) => [link.externalId, row.id] as const)));
        frameDetail(`${rows.length} active; ${rows.length - missing.length} MAL-linked; ${missing.length} missing; ${missing.length - eligible.length} without AniList; ${selected.length} to check`);
        let matched = 0;
        let unmatched = 0;
        let errors = 0;
        for (const [index, row] of selected.entries()) {
          if (index > 0) {await new Promise((resolve) => setTimeout(resolve, delay));}
          const anilistId = row.providers.find((link) => link.provider === "anilist")?.externalId;
          if (!anilistId) {continue;}
          try {
            const canonical = await Effect.runPromise(source.getById(anilistId));
            const malId = canonical?.externalIds?.mal;
            if (!malId) {
              unmatched += 1;
              frameDetail(`UNMAPPED ${row.id} anilist:${anilistId}`);
              continue;
            }
            if (canonical?.providerId !== anilistId || !/^[1-9]\d*$/.test(malId)) {
              throw new Error("Invalid AniList cross-link response");
            }
            const owner = owners.get(malId);
            if (owner && owner !== row.id) {throw new Error(`mal:${malId} already belongs to ${owner}`);}
            if (apply) {
              // Ingestion rejects conflicting ownership; linkProvider would move the link.
              await apiCall(config, "/v1/registry/ingest", "POST", {
                provider: "anilist", providerId: anilistId, title: row.title,
                links: [{ provider: "mal", externalId: malId }],
              }, RegistryEntry);
            }
            owners.set(malId, row.id);
            matched += 1;
            frameDetail(`${apply ? "LINKED" : "WOULD LINK"} ${row.id} anilist:${anilistId} → mal:${malId}`);
          } catch (error) {
            errors += 1;
            frameDetail(`ERROR ${row.id}: ${errorMessage(error)}`);
          }
        }
        closeFrame(`${matched} ${apply ? "linked" : "verified"}; ${unmatched} unmapped; ${errors} errors`);
        if (errors > 0) {throw new Error(`${errors} MAL link checks failed; inspect the report and rerun`);}
      } catch (error) {
        abortFrame();
        throw error;
      }
    },
    catch: (cause) => new Error(errorMessage(cause)),
  })),
);
