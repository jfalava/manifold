/** @effect-diagnostics asyncFunction:off */
/**
 * Host-side AniList outbox drain (oci-agents / always-on CLI).
 *
 * Same contract as the packages/paperback-runtime device drain:
 *   GET  /v1/ops/pending/anilist → execute GraphQL → POST /v1/ops/complete
 *
 * Runs on a non-Cloudflare egress IP (prefer IPv6). The AniList writes are the
 * device's own client from @manifold/paperback-runtime/anilist; only the
 * transport differs (fetch here, Application.scheduleRequest on device).
 */
import { isString, manifoldUserAgent } from "@manifold/json";
import {
  createAniListClient,
  decodeAniListViewer,
  viewerQuery,
  type AniListTransport,
} from "@manifold/paperback-runtime/anilist";
import { Effect } from "effect";

import { parsePendingAniListOp, type PendingAniListOp } from "@manifold/contract";

export type { PendingAniListOp };

import { cliError, fromPromise, platformFetch, runHost, type CliEffectError } from "@/effect-kit";

const DRAIN_BATCH_LIMIT = 25;

export type DrainApiClient = {
  readonly pendingAniListOps: (limit?: number) => Promise<readonly PendingAniListOp[]>;
  readonly completeOps: (
    results: readonly {
      readonly opId: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly mediaListEntryId?: number;
    }[],
  ) => Promise<{ updated: number }>;
};

export type DrainPassSummary = {
  readonly fetched: number;
  readonly ok: number;
  readonly failed: number;
  readonly reported: number;
};

export type DrainOpResult = {
  readonly opId: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly mediaListEntryId?: number;
  readonly kind: string;
};

const errorText = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (isString(cause)) {
    return cause;
  }

  return "unknown error";
};

const fetchTransport: AniListTransport = {
  post: async ({ url, headers, body }) => {
    const response = await platformFetch(url, { method: "POST", headers, body });

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    };
  },
  sleep: (ms) => Bun.sleep(ms),
  userAgent: manifoldUserAgent("cli-drain"),
};

let aniList = createAniListClient(fetchTransport);

const fetchViewerIdEffect = (token: string): Effect.Effect<number, CliEffectError> =>
  fromPromise(() => aniList.aniListRequest(token, viewerQuery, {}, decodeAniListViewer)).pipe(
    Effect.map((data) => data.Viewer.id),
  );

const executeOpEffect = (
  token: string,
  op: PendingAniListOp,
  mediaListEntryIds: Readonly<Record<string, number>> | undefined,
): Effect.Effect<number | undefined, CliEffectError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parsePendingAniListOp(op),
      catch: (cause) =>
        cliError(cause instanceof Error ? cause.message : `op ${op.opId}: parse failed`),
    });

    switch (parsed.kind) {
      case "anilist.status": {
        const result = yield* fromPromise(() =>
          aniList.saveAniListStatus(token, parsed.anilistId, parsed.status),
        );

        return result.mediaListEntryId;
      }

      case "anilist.progress": {
        yield* fromPromise(() =>
          aniList.saveAniListProgress(token, parsed.anilistId, parsed.progress),
        );

        return undefined;
      }

      case "anilist.fields": {
        yield* fromPromise(() => aniList.saveAniListFields(token, parsed.anilistId, parsed.change));

        return parsed.mediaListEntryId;
      }

      case "anilist.delete": {
        const listEntryId = parsed.mediaListEntryId ?? mediaListEntryIds?.[parsed.anilistId];

        if (listEntryId === undefined) {
          return yield* cliError(`op ${parsed.opId}: no mediaListEntryId for ${parsed.anilistId}`);
        }

        const deleted = yield* fromPromise(() => aniList.deleteAniListEntry(token, listEntryId));

        if (!deleted) {
          return yield* cliError(
            `DeleteMediaListEntry did not confirm deletion for ${listEntryId}`,
          );
        }

        return listEntryId;
      }
    }
  });

/**
 * One drain pass: fetch pending anilist:* ops, execute, report outcomes.
 * Empty queue is success with zeros.
 */
export const drainAniListOpsPassEffect = (
  api: DrainApiClient,
  anilistToken: string,
  options?: { readonly limit?: number },
): Effect.Effect<DrainPassSummary, CliEffectError> =>
  Effect.gen(function* () {
    const limit = options?.limit ?? DRAIN_BATCH_LIMIT;

    const ops = yield* fromPromise(() => api.pendingAniListOps(limit)).pipe(
      Effect.mapError((cause) => cliError(`pending AniList ops failed: ${errorText(cause)}`)),
    );

    if (ops.length === 0) {
      return { fetched: 0, ok: 0, failed: 0, reported: 0 };
    }

    const needsListEntryIds = ops.some(
      (op) => op.kind === "anilist.delete" && op.payload["mediaListEntryId"] === undefined,
    );

    const mediaListEntryIds = needsListEntryIds
      ? yield* fetchViewerIdEffect(anilistToken).pipe(
          Effect.flatMap((userId) =>
            fromPromise(() => aniList.fetchAniListMediaListEntryIds(anilistToken, userId)),
          ),
        )
      : undefined;

    const results: DrainOpResult[] = [];

    for (const op of ops) {
      const outcome = yield* executeOpEffect(anilistToken, op, mediaListEntryIds).pipe(
        Effect.map((mediaListEntryId) => ({
          ok: true as const,
          mediaListEntryId,
        })),
        Effect.catch((cause) => Effect.succeed({ ok: false as const, error: errorText(cause) })),
      );

      if (!outcome.ok) {
        results.push({ opId: op.opId, ok: false, error: outcome.error, kind: op.kind });
        continue;
      }

      results.push({
        opId: op.opId,
        ok: true,
        kind: op.kind,
        ...(outcome.mediaListEntryId !== undefined && {
          mediaListEntryId: outcome.mediaListEntryId,
        }),
      });
    }

    const reportBody = results.map((r) => ({
      opId: r.opId,
      ok: r.ok,
      ...(r.error !== undefined && { error: r.error }),
      ...(r.mediaListEntryId !== undefined && { mediaListEntryId: r.mediaListEntryId }),
    }));

    const { updated } = yield* fromPromise(() => api.completeOps(reportBody)).pipe(
      Effect.mapError((cause) => cliError(`complete ops failed: ${errorText(cause)}`)),
    );

    return {
      fetched: ops.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      reported: updated,
    };
  });

export const drainAniListOpsPass = (
  api: DrainApiClient,
  anilistToken: string,
  options?: { readonly limit?: number },
): Promise<DrainPassSummary> => runHost(drainAniListOpsPassEffect(api, anilistToken, options));

/** @internal Tests drop request spacing and restore it afterwards. */
export const __drainTest = {
  resetThrottle: (): void => {
    aniList = createAniListClient({ ...fetchTransport, minRequestSpacingMs: 0 });
  },
  restoreThrottle: (): void => {
    aniList = createAniListClient(fetchTransport);
  },
};
