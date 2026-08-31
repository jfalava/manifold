import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { ListrTask } from "listr2";
import {
  createComixBrowser,
  findChromeExecutable,
  launchComixChrome,
  openBunComixView,
  waitForChromeDevToolsUrl,
} from "@/comix-capture";
import { loadRegistrySearchTitles, searchTitlesFor } from "@/comix-aliases";
import { hidOf, pickMatch, type ComixSearchItem } from "@/comix-match";
import {
  bunSecretStore,
  clearStoredSession,
  cookiesFromFlags,
  loadStoredSession,
  saveStoredSession,
  sessionFromCookies,
  type ComixCookie,
} from "@/comix-session";
import { resolveValue } from "@/env-resolve";
import {
  matchesStatusFilter,
  parseStatusFilter,
  STATUS_FILTER_HINT,
} from "@/registry-status";
import {
  abortFrame,
  closeFrame,
  createRun,
  frameDetail,
  makePhaseReporter,
  openFrame,
  waitForEnterInFrame,
  type RunContext,
} from "@/ui";
import { apiCall, apiConfig, type ApiConfig, type RegistryRow } from "@/commands/toolbox";

const SEARCH_DELAY_MS = 1_500;
const CHALLENGE_CIRCUIT_BREAK = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ComixCtx extends RunContext {
  unmatched: RegistryRow[];
  linked: number;
  misses: number;
  challenges: number;
}

export const comixPrefillCommand = Command.make("comix", {
  apply: Flag.boolean("apply").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Write links to the registry (default: dry-run)."),
  ),
  limit: Flag.integer("limit").pipe(
    Flag.optional,
    Flag.withDescription("Max entries to process this run (default: all without comix)."),
  ),
  status: Flag.string("status").pipe(
    Flag.withDefault("auto"),
    Flag.withDescription(
      `Only prefill rows whose registry reading status matches. ${STATUS_FILTER_HINT}.`,
    ),
  ),
  chromeCdpUrl: Flag.string("chrome-cdp-url").pipe(
    Flag.optional,
    Flag.withDescription("DevTools WebSocket of a running Chrome (ws://127.0.0.1:9222/...). Overrides COMIX_CHROME_CDP_URL."),
  ),
  refreshSession: Flag.boolean("refresh-session").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Drop the Keychain jar and harvest a new one."),
  ),
  cfClearance: Flag.string("cf-clearance").pipe(
    Flag.optional,
    Flag.withDescription("Optional seed cf_clearance. Falls back to COMIX_CF_CLEARANCE / ALCHEMY_SECRET_COMIX_CF_CLEARANCE."),
  ),
  session: Flag.string("session").pipe(
    Flag.optional,
    Flag.withDescription("Optional seed session cookie. Falls back to COMIX_SESSION / ALCHEMY_SECRET_COMIX_SESSION."),
  ),
  cookies: Flag.string("cookies").pipe(
    Flag.optional,
    Flag.withDescription("Optional seed Cookie header. Overrides the individual cookie flags. Falls back to COMIX_COOKIES / ALCHEMY_SECRET_COMIX_COOKIES."),
  ),
  apiOrigin: Flag.string("api-origin").pipe(Flag.optional),
  apiToken: Flag.string("api-token").pipe(Flag.optional),
  anilistToken: Flag.string("anilist-token").pipe(
    Flag.optional,
    Flag.withDescription("Falls back to ANILIST_TOKEN / ALCHEMY_SECRET_ANILIST_TOKEN. Used to search Comix with English/romaji aliases."),
  ),
}).pipe(
  Command.withDescription(
    "Backfill comix hid provider links for registry rows. Captures comix.to search in a local Chrome WebView; the cookie jar is stored in the OS keychain until cf_clearance expires.",
  ),
  Command.withHandler(
    ({
      apply,
      limit,
      status,
      chromeCdpUrl,
      refreshSession,
      cfClearance,
      session,
      cookies,
      apiOrigin,
      apiToken,
      anilistToken,
    }) =>
      Effect.tryPromise({
        try: async () => {
          const config: ApiConfig = apiConfig(apiOrigin, apiToken);
          const statusFilter = parseStatusFilter(status);
          if (refreshSession) await clearStoredSession(bunSecretStore);
          const seedCookies = cookiesFromFlags({
            cfClearance: resolveValue(
              cfClearance,
              "COMIX_CF_CLEARANCE",
              "ALCHEMY_SECRET_COMIX_CF_CLEARANCE",
            ),
            session: resolveValue(
              session,
              "COMIX_SESSION",
              "ALCHEMY_SECRET_COMIX_SESSION",
            ),
            cookieHeader: resolveValue(
              cookies,
              "COMIX_COOKIES",
              "ALCHEMY_SECRET_COMIX_COOKIES",
            ),
          });
          const stored = seedCookies.length > 0 ? undefined : await loadStoredSession(bunSecretStore);
          const anilist = resolveValue(
            anilistToken,
            "ANILIST_TOKEN",
            "ALCHEMY_SECRET_ANILIST_TOKEN",
          );
          let chromeUrl = resolveValue(chromeCdpUrl, "COMIX_CHROME_CDP_URL") ?? await waitForChromeDevToolsUrl({
            timeoutMs: 1_000,
          });

          openFrame(`Comix registry prefill → ${apply ? "apply" : "dry run"}`);
          frameDetail("search runs in a headed Chrome window, not as a pasted Cookie header");
          if (statusFilter) {
            frameDetail(`status filter: ${[...statusFilter].join(", ")}`);
          }
          if (!chromeUrl) {
            const executable = findChromeExecutable();
            if (!executable) {
              throw new Error("Chrome/Chromium/Edge/Brave not found. Install one, then re-run.");
            }
            frameDetail(`opening ${executable} with a dedicated manifold profile`);
            frameDetail("Chrome 136+ ignores --remote-debugging-port on your default profile, so this is a separate window");
            launchComixChrome({ executable });
            frameDetail("waiting for DevTools on 9222…");
            chromeUrl = await waitForChromeDevToolsUrl({ timeoutMs: 20_000 });
          }
          if (!chromeUrl) {
            throw new Error(
              "Chrome DevTools never came up. Quit every Chrome window, then re-run so manifold can open its own debug profile.",
            );
          }
          const attachUrl = chromeUrl;
          frameDetail(`attaching to ${attachUrl}`);
          if (seedCookies.length > 0) {
            frameDetail(`seeding ${seedCookies.length} cookie(s) from flags/env into the view`);
          } else if (stored) {
            frameDetail("reusing the Keychain jar until cf_clearance expires");
          }
          if (anilist) {
            frameDetail("searching Comix with AniList english/romaji/synonyms, then MangaDex alts if needed");
          } else {
            frameDetail("no ANILIST_TOKEN: searching the registry title, then MangaDex alts if a mangadex link exists");
          }

          const limitValue = Option.getOrUndefined(limit);

          const loadTask: ListrTask<ComixCtx> = {
            title: "Load registry rows",
            task: async (ctx, task) => {
              // Full-registry prefill: comix is a per-title fallback (chapters
              // may be stripped on mangadex even when the link exists), so the
              // CLI should populate every missing hid. The device then picks the
              // richer provider at read time. Pages past the old LIMIT 500.
              const PAGE_SIZE = 5000;
              let offset = 0;
              let page: readonly RegistryRow[];
              const allRows: RegistryRow[] = [];
              do {
                const body = await apiCall<{ entries: readonly RegistryRow[] }>(
                  config,
                  `/v1/registry?limit=${PAGE_SIZE}&offset=${offset}`,
                );
                page = body.entries;
                allRows.push(...page);
                offset += page.length;
              } while (page.length === PAGE_SIZE);
              const total = allRows.length;
              const withoutComix = allRows.filter(
                (row) => !row.providers.some((provider) => provider.provider === "comix"),
              );
              const statusMatched = withoutComix.filter((row) =>
                matchesStatusFilter(row.state?.status, statusFilter),
              );
              ctx.unmatched = statusMatched;
              if (limitValue !== undefined && limitValue >= 0) {
                ctx.unmatched = ctx.unmatched.slice(0, limitValue);
              }
              const statusNote =
                statusFilter === undefined
                  ? ""
                  : ` · ${statusMatched.length}/${withoutComix.length} match --status`;
              makePhaseReporter(task).note(
                `❖ ${total} rows (paged, limit=${PAGE_SIZE}) · ${withoutComix.length} without comix${statusNote} → ${ctx.unmatched.length} to fill (every missing hid — device picks richer provider)` +
                  (limitValue !== undefined ? ` (showing first ${ctx.unmatched.length})` : ""),
              );
            },
            rendererOptions: { outputBar: Infinity },
          };

          const persistHarvest = async (
            browser: { harvest: () => Promise<{ cookies: ComixCookie[]; userAgent?: string }> },
          ): Promise<void> => {
            try {
              const harvested = await browser.harvest();
              if (harvested.cookies.some((cookie) => cookie.name === "cf_clearance")) {
                await saveStoredSession(
                  bunSecretStore,
                  sessionFromCookies(harvested.cookies, harvested.userAgent),
                );
              }
            } catch {
              // closing a challenged view can fail CDP; keep the last good jar
            }
          };

          const sweepTask: ListrTask<ComixCtx> = {
            title: `Search comix${apply ? " and link" : ""}`,
            task: async (ctx, task) => {
              const baseTitle = task.title;
              const reporter = makePhaseReporter(task);
              const total = ctx.unmatched.length;
              const counts = (): readonly [string, number][] => [
                ["linked", ctx.linked],
                ["miss", ctx.misses],
                ["challenge", ctx.challenges],
              ];
              const done = (): number => ctx.linked + ctx.misses + ctx.challenges;
              const formatTitle = (rowTitle: string, suffix = ""): string => {
                const cols = process.stdout.columns ?? 80;
                const budget = Math.max(24, Math.min(48, cols - baseTitle.length - 16 - suffix.length));
                const clean = rowTitle.replace(/\s+/g, " ").trim();
                const short = clean.length > budget ? `${clean.slice(0, budget - 1)}…` : clean;
                return suffix ? `${short}${suffix}` : short;
              };

              const view = openBunComixView({ chromeUrl: attachUrl });
              const browser = await createComixBrowser({
                view,
                cookies: seedCookies.length > 0 ? seedCookies : stored?.cookies,
              });

              try {
                if (total > 0) reporter.progress(0, total, counts());
                let waitedForUser = false;
                let persisted = false;
                for (const row of ctx.unmatched) {
                  task.title = `${baseTitle} — ${formatTitle(row.title)}`;
                  const searchTerms = searchTitlesFor(
                    await loadRegistrySearchTitles(row, { anilistToken: anilist }),
                  );
                  let items: ComixSearchItem[] = [];
                  let challenged = false;
                  for (const term of searchTerms) {
                    let captured: readonly ComixSearchItem[] | "challenge" = await browser.search(term);
                    if (captured === "challenge" && !waitedForUser) {
                      reporter.note(
                        "Cloudflare challenged this session. Solve it in the manifold Chrome window, then press Enter.",
                      );
                      await waitForEnterInFrame("press Enter after comix.to loads");
                      waitedForUser = true;
                      captured = await browser.search(term);
                    }
                    if (captured === "challenge") {
                      challenged = true;
                      break;
                    }
                    if (!persisted) {
                      await persistHarvest(browser);
                      persisted = true;
                    }
                    const seen = new Set(
                      items.map(hidOf).filter((hid): hid is string => hid !== undefined),
                    );
                    for (const item of captured) {
                      const hid = hidOf(item);
                      if (hid !== undefined && seen.has(hid)) continue;
                      if (hid !== undefined) seen.add(hid);
                      items.push(item);
                    }
                    if (pickMatch(items, searchTerms)) break;
                    await sleep(SEARCH_DELAY_MS);
                  }
                  if (challenged) {
                    ctx.challenges += 1;
                    task.title = `${baseTitle} — ${formatTitle(row.title, " — challenged")}`;
                    reporter.progress(done(), total, counts());
                    if (ctx.challenges >= CHALLENGE_CIRCUIT_BREAK) {
                      reporter.note(
                        "circuit break: solve Cloudflare in the manifold Chrome window, then re-run",
                      );
                      break;
                    }
                    await sleep(SEARCH_DELAY_MS);
                    continue;
                  }
                  const match = pickMatch(items, searchTerms);
                  const hid = match === undefined ? undefined : hidOf(match);
                  if (hid === undefined) {
                    ctx.misses += 1;
                    task.title = `${baseTitle} — ${formatTitle(row.title, " — miss")}`;
                  } else {
                    ctx.linked += 1;
                    if (apply) {
                      await apiCall(
                        config,
                        `/v1/entries/${encodeURIComponent(row.id)}/providers`,
                        "POST",
                        { provider: "comix", externalId: hid, title: row.title },
                      );
                    }
                    const slug = typeof match?.slug === "string" ? `-${match.slug.slice(0, 12)}` : "";
                    task.title = `${baseTitle} — ${formatTitle(row.title, ` → ${hid.slice(0, 8)}…${slug}`)}`;
                  }
                  reporter.progress(done(), total, counts());
                  await sleep(SEARCH_DELAY_MS);
                }
                await persistHarvest(browser);
                task.title = baseTitle;
                reporter.note(
                  `❖ ${apply ? "Applied" : "Dry run"}: ${ctx.linked} matched · ${ctx.misses} misses · ${ctx.challenges} challenges. Re-run with --apply to write.`,
                );
              } finally {
                browser.close();
              }
            },
            rendererOptions: { outputBar: 1, persistentOutput: true },
          };

          const run = createRun<ComixCtx>([loadTask, sweepTask]);
          const ctx: ComixCtx = { unmatched: [], linked: 0, misses: 0, challenges: 0 };
          try {
            await run.run(ctx);
            closeFrame(apply ? "Comix prefill applied" : "Comix prefill dry run finished");
          } catch (error) {
            abortFrame();
            throw error;
          }
          // Bun's keep-alive sockets hold the loop open; the CLI has nothing
          // left to do once the report is printed.
          process.exit(0);
        },
        catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
      }),
  ),
);
