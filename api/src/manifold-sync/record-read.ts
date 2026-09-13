import { Effect } from "effect";
import { scheduleSync } from "./schedule";
import { fromPromise } from "./from-promise";
import { appendEvent, enqueueOp, getProgressSync } from "./sql-helpers";
import type { SyncHost } from "./host";
import { now } from "./constants";
import { hostLogError, newId } from "../effect-host";
import { errorMessage, type JsonObject } from "@manifold/json";
import type { ReadingProgress, RecordReadInput } from "../domain";
import { type ProgressRow, shouldAdvanceProgress } from "../sync-rows";

const recordReadEffect = (host: SyncHost, entryId: string, input: RecordReadInput) =>
  Effect.gen(function* () {
    // Validation can reject after recovery or link observation. Commit those
    // changes together with progress and queued work, or roll all of them back.
    const progress = host.ctx.storage.transactionSync(() => {
      const eventId = input.eventId ?? newId();
      const readAt = input.readAt ?? now();
      // Resolved target may differ from the caller's entryId when a
      // missing or tombstoned row has a live successor — never reassign the param.
      let targetEntryId = entryId;

      const corpse = host.ctx.storage.sql
        .exec<{ tombstoned_at: number | null }>(
          "SELECT tombstoned_at FROM canonical_entries WHERE id = ?",
          targetEntryId,
        )
        .toArray()[0];
      if (!corpse || corpse.tombstoned_at !== null) {
        // Queued device actions can outlive registry rows as well as nukes.
        // Recover only through the read's exact native provider identity;
        // never invent an entry or match by title. Without a successor, only
        // an existing tombstone can be resurrected.
        const successor = host.ctx.storage.sql
          .exec<{ entry_id: string }>(
            `SELECT pl.entry_id FROM provider_links pl
         JOIN canonical_entries ce ON ce.id = pl.entry_id
         WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL
         LIMIT 1`,
            input.provider,
            input.sourceMangaId,
          )
          .toArray()[0];
        if (successor) {
          targetEntryId = successor.entry_id;
        } else if (!corpse) {
          throw new Error(`Canonical entry not found: ${targetEntryId}`);
        } else {
          host.ctx.storage.sql.exec(
            "UPDATE canonical_entries SET tombstoned_at = NULL, updated_at = ? WHERE id = ?",
            now(),
            targetEntryId,
          );
          appendEvent(host, targetEntryId, "list.resurrect", "device", {});
        }
      }

      const providerLink = host.ctx.storage.sql
        .exec<{ external_id: string }>(
          "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = ? LIMIT 1",
          targetEntryId,
          input.provider,
        )
        .toArray()[0];
      if (providerLink && providerLink.external_id !== input.sourceMangaId) {
        throw new Error(
          `Registry entry ${targetEntryId} has ${input.provider}:${providerLink.external_id}, not ${input.sourceMangaId}`,
        );
      }
      if (!providerLink) {
        const owner = host.ctx.storage.sql
          .exec<{ entry_id: string }>(
            "SELECT entry_id FROM provider_links WHERE provider = ? AND external_id = ? LIMIT 1",
            input.provider,
            input.sourceMangaId,
          )
          .toArray()[0];
        if (owner && owner.entry_id !== targetEntryId) {
          throw new Error(
            `${input.provider}:${input.sourceMangaId} belongs to registry entry ${owner.entry_id}`,
          );
        }
        const timestamp = now();
        host.ctx.storage.sql.exec(
          `INSERT INTO provider_links
         (entry_id, provider, external_id, title, updated_at)
       VALUES (?, ?, ?, NULL, ?)`,
          targetEntryId,
          input.provider,
          input.sourceMangaId,
          timestamp,
        );
        host.ctx.storage.sql.exec(
          "UPDATE canonical_entries SET updated_at = ? WHERE id = ?",
          timestamp,
          targetEntryId,
        );
        appendEvent(host, targetEntryId, "link.observed", "device", {
          provider: input.provider,
          externalId: input.sourceMangaId,
        });
      }

      const existingEvent = host.ctx.storage.sql
        .exec<{ entry_id: string }>("SELECT entry_id FROM read_events WHERE event_id = ?", eventId)
        .toArray()[0];

      if (existingEvent) {
        if (existingEvent.entry_id !== targetEntryId) {
          throw new Error(`Read event ${eventId} belongs to another entry`);
        }
      } else {
        host.ctx.storage.sql.exec(
          `INSERT INTO read_events
         (event_id, entry_id, chapter_key, read_at)
       VALUES (?, ?, ?, ?)`,
          eventId,
          targetEntryId,
          input.chapterKey,
          readAt,
        );

        const current = host.ctx.storage.sql
          .exec<ProgressRow>("SELECT * FROM progress_state WHERE entry_id = ?", targetEntryId)
          .toArray()[0];
        if (shouldAdvanceProgress(current, input.chapterNumber, readAt)) {
          const nextVersion = (current?.version ?? 0) + 1;
          host.ctx.storage.sql.exec(
            `INSERT INTO progress_state
           (entry_id, chapter_key, chapter_number, volume_number, provider,
            source_chapter_id, read_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           chapter_key = excluded.chapter_key,
           chapter_number = excluded.chapter_number,
           volume_number = excluded.volume_number,
           provider = excluded.provider,
           source_chapter_id = excluded.source_chapter_id,
           read_at = excluded.read_at,
           version = excluded.version`,
            targetEntryId,
            input.chapterKey,
            input.chapterNumber ?? null,
            input.volumeNumber ?? null,
            input.provider ?? null,
            input.sourceChapterId ?? null,
            readAt,
            nextVersion,
          );
        }

        if (input.provider === "mangadex" && input.sourceChapterId) {
          const payload: JsonObject = {
            entryId: targetEntryId,
            chapterKey: input.chapterKey,
            eventId,
            readAt,
            ...(input.chapterNumber !== undefined && { chapterNumber: input.chapterNumber }),
            ...(input.volumeNumber !== undefined && { volumeNumber: input.volumeNumber }),
            provider: input.provider,
            sourceChapterId: input.sourceChapterId,
          };
          enqueueOp(host, {
            opId: eventId,
            target: "mangadex",
            kind: "mangadex.read",
            origin: "device",
            payload,
          });
        }

        // Shelf mirror: any chapter read (MangaDex or Comix fallback) on a
        // title that has a MangaDex provider link but is not yet on the
        // user's MangaDex library should appear there as "reading".
        // Copyrighted titles without an MD link are skipped — nothing to
        // mark. Deduplicated by primary key until drained.
        const mdLink = host.ctx.storage.sql
          .exec<{ external_id: string }>(
            "SELECT external_id FROM provider_links WHERE entry_id = ? AND provider = 'mangadex' LIMIT 1",
            targetEntryId,
          )
          .toArray()[0];
        if (mdLink) {
          host.ctx.storage.sql.exec(
            `INSERT INTO md_status_queue (entry_id, created_at, attempts)
         VALUES (?, ?, 0)
         ON CONFLICT(entry_id) DO NOTHING`,
            targetEntryId,
            now(),
          );
        }
      }

      const written = getProgressSync(host, targetEntryId);
      if (!written) {
        throw new Error(`Progress was not written for entry ${targetEntryId}`);
      }
      return written;
    });
    yield* fromPromise(() => scheduleSync(host)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          hostLogError(`[ManifoldSync] failed to schedule MangaDex sync: ${errorMessage(error)}`);
        }),
      ),
    );
    return progress;
  });

export const recordRead = (
  host: SyncHost,
  entryId: string,
  input: RecordReadInput,
): Promise<ReadingProgress> => Effect.runPromise(recordReadEffect(host, entryId, input));
