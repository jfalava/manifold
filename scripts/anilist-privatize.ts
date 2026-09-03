/**
 * Marks every manga list entry on an AniList account as private.
 *
 * Usage:
 *   bun scripts/anilist-privatize.ts --token <MANIFOLD_ANILIST_TOKEN> [--dry-run]
 *   MANIFOLD_ANILIST_TOKEN=<...> bun scripts/anilist-privatize.ts [--dry-run]
 *
 * A fresh token can be captured at:
 *   https://manifold.jfa.dev/api/v1/auth/anilist/device
 *
 * AniList has no bulk update mutation, so this walks the full manga list
 * and issues one SaveMediaListEntry per not-yet-private entry, throttled
 * well below the published rate limit.
 */

import type { JsonObject } from "@manifold/json";

const ENDPOINT = "https://graphql.anilist.co";
const REQUEST_INTERVAL_MS = 1200; // ~50 req/min, comfortably under the 90/min limit

interface CliArgs {
  token?: string;
  dryRun: boolean;
}

interface GraphQLResponse<A> {
  data?: A;
  errors?: { message?: string }[];
}

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);
  let token: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--token") {
      token = argv[i + 1];
    }
    if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { token: token ?? process.env.MANIFOLD_ANILIST_TOKEN, dryRun };
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const gql = async <A>(
  token: string,
  query: string,
  variables: JsonObject = {},
): Promise<A> => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "5");
    console.log(`  rate limited, waiting ${retryAfter}s…`);
    await sleep(Math.max(retryAfter, 5) * 1000);
    return gql<A>(token, query, variables);
  }
  // SAFETY: AniList GraphQL envelope is validated for errors/ok below before data is used
  const body = (await response.json()) as GraphQLResponse<A>;
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? "?").join("; "));
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  // SAFETY: caller supplies A; AniList returns that selection set when errors is empty
  return body.data as A;
};

const main = async (): Promise<void> => {
  const { token, dryRun } = parseArgs();
  if (!token) {
    console.error("Missing token. Pass --token <TOKEN> or set MANIFOLD_ANILIST_TOKEN.");
    process.exitCode = 1;
    return;
  }

  const viewer = await gql<{ Viewer: { id: number; name: string } }>(
    token,
    `query { Viewer { id name } }`,
  );
  console.log(`Account: ${viewer.Viewer.name} (${viewer.Viewer.id})`);

  const collection = await gql<{
    MediaListCollection: {
      lists: { entries: { private: boolean; media: { id: number } | null } | null }[] | null;
    };
  }>(
    token,
    `query ($userId: Int) {
      MediaListCollection(userId: $userId, type: MANGA) {
        lists { entries { private media { id } } }
      }
    }`,
    { userId: viewer.Viewer.id },
  );

  const mediaIds = new Set<number>();
  let alreadyPrivate = 0;
  for (const list of collection.MediaListCollection.lists ?? []) {
    for (const entry of list.entries ?? []) {
      const mediaId = entry.media?.id;
      if (!mediaId) {
        continue;
      }
      if (entry.private) {
        alreadyPrivate += 1;
      } else {
        mediaIds.add(mediaId);
      }
    }
  }

  console.log(
    `${alreadyPrivate} entries already private, ${mediaIds.size} to privatize` +
      (dryRun ? " (dry run — no changes will be made)" : ""),
  );
  if (dryRun || mediaIds.size === 0) {
    return;
  }

  let done = 0;
  let failed = 0;
  for (const mediaId of mediaIds) {
    try {
      await gql(
        token,
        `mutation ($mediaId: Int!) {
          SaveMediaListEntry(mediaId: $mediaId, private: true) { id private }
        }`,
        { mediaId },
      );
      done += 1;
    } catch (cause) {
      failed += 1;
      console.error(
        `  media ${mediaId} failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
    if (done % 25 === 0) {
      console.log(`  ${done}/${mediaIds.size}…`);
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  console.log(`Done. privatized=${done} failed=${failed} alreadyPrivate=${alreadyPrivate}`);
};

await main();
