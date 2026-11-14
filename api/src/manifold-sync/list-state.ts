import { Effect, Option, Schema } from "effect";
import { scheduleSync } from "./schedule";
import { fromPromise } from "./from-promise";
import { anilistLinkOf, appendEvent, enqueueOp, readListState, requireEntry } from "./sql-helpers";
import type { SyncHost } from "./host";
import { now } from "./constants";
import { newId } from "../effect-host";
import { type JsonObject } from "@manifold/json";
import type { ListState, NukeEntryInput, OpOrigin, SetListStateInput } from "../domain";
import { createAniListListStateOpPayload } from "../list-state-op";
import { MalBackupPayload } from "../mal-backup";
import { type ListEventRow, type OpRow, toListEvent } from "../sync-rows";

const setListStateEffect = (host: SyncHost, entryId: string, input: SetListStateInput) =>
  Effect.gen(function* () {
    // The state row, its event and the ops it queues are written together or
    // not at all. Scheduling awaits, so it stays outside the transaction.
    const written = host.ctx.storage.transactionSync(() => {
      const changes = input;
      requireEntry(host, entryId);
      const timestamp = now();
      const current = readListState(host, entryId);
      const anilistId = anilistLinkOf(host, entryId);

      const nextStatus =
        changes.status === undefined ? current?.status : (changes.status ?? undefined);

      const nextScore = changes.score === undefined ? current?.score : (changes.score ?? undefined);
      const nextNotes = changes.notes === undefined ? current?.notes : (changes.notes ?? undefined);

      const nextStarted =
        changes.startedAt === undefined ? current?.startedAt : (changes.startedAt ?? undefined);

      const nextCompleted =
        changes.completedAt === undefined
          ? current?.completedAt
          : (changes.completedAt ?? undefined);

      const nextVolumes =
        changes.volumeProgress === undefined
          ? current?.volumeProgress
          : (changes.volumeProgress ?? undefined);

      const mediaListEntryId = current?.mediaListEntryId;

      host.ctx.storage.sql.exec(
        `INSERT INTO list_state
       (entry_id, status, score, notes, started_at, completed_at, volume_progress,
        media_list_entry_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       status = excluded.status,
       score = excluded.score,
       notes = excluded.notes,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       volume_progress = excluded.volume_progress,
       media_list_entry_id = COALESCE(excluded.media_list_entry_id, list_state.media_list_entry_id),
       updated_at = excluded.updated_at`,
        entryId,
        nextStatus ?? null,
        nextScore ?? null,
        nextNotes ?? null,
        nextStarted ?? null,
        nextCompleted ?? null,
        nextVolumes ?? null,
        mediaListEntryId ?? null,
        timestamp,
      );

      const origin: OpOrigin = changes.origin ?? "admin";

      const eventDetail: JsonObject = {
        ...(changes.status !== undefined && { status: changes.status }),
        ...(changes.score !== undefined && { score: changes.score }),
        ...(changes.notes !== undefined && { notes: changes.notes }),
        ...(changes.startedAt !== undefined && { startedAt: changes.startedAt }),
        ...(changes.completedAt !== undefined && { completedAt: changes.completedAt }),
        ...(changes.volumeProgress !== undefined && { volumeProgress: changes.volumeProgress }),
        ...(changes.origin !== undefined && { origin: changes.origin }),
        ...(changes.appliedRemotely !== undefined && { appliedRemotely: changes.appliedRemotely }),
      };

      appendEvent(host, entryId, "list.state", origin, eventDetail);

      // AniList has no entry without a status, so a cleared status stays local:
      // an op carrying it could only fail on the device until it blocked.
      const remoteStatus = changes.status ?? undefined;

      // Device-originated mutations were already applied to AniList on-device;
      // everything else becomes an op the device will drain.
      if (
        !changes.appliedRemotely &&
        anilistId &&
        (remoteStatus !== undefined ||
          changes.score !== undefined ||
          changes.notes !== undefined ||
          changes.startedAt !== undefined ||
          changes.completedAt !== undefined ||
          changes.volumeProgress !== undefined)
      ) {
        const onlyStatus =
          remoteStatus !== undefined &&
          changes.score === undefined &&
          changes.notes === undefined &&
          changes.startedAt === undefined &&
          changes.completedAt === undefined &&
          changes.volumeProgress === undefined;

        enqueueOp(host, {
          opId: newId(),
          target: "anilist",
          kind: onlyStatus ? "anilist.status" : "anilist.fields",
          origin,
          payload: createAniListListStateOpPayload(entryId, anilistId, mediaListEntryId, changes),
        });
      }

      const stored = readListState(host, entryId);

      if (!stored) {
        throw new Error(`List state missing after write: ${entryId}`);
      }

      // MAL is only a backup sink. The original update commits before any
      // upstream work, regardless of whether AniList was already updated.
      if (origin === "device" && stored.status) {
        enqueueMalBackup(host, entryId, changes);

        return { stored, backup: true };
      }

      return { stored, backup: false };
    });

    if (written.backup) {
      yield* fromPromise(() => scheduleSync(host));
    }

    return written.stored;
  });

export const setListState = (
  host: SyncHost,
  entryId: string,
  input: SetListStateInput,
): Promise<ListState> => Effect.runPromise(setListStateEffect(host, entryId, input));

export function getListState(host: SyncHost, entryId: string): ListState | undefined {
  return readListState(host, entryId);
}

export function nukeEntry(
  host: SyncHost,
  entryId: string,
  input: NukeEntryInput,
): ListState | undefined {
  // The delete op, the tombstone and its event are written together or not at all.
  return host.ctx.storage.transactionSync(() => {
    const origin: OpOrigin = input.origin ?? "admin";
    requireEntry(host, entryId);
    const anilistId = anilistLinkOf(host, entryId);
    const current = readListState(host, entryId);

    if (origin !== "device" && anilistId) {
      enqueueOp(host, {
        opId: newId(),
        target: "anilist",
        kind: "anilist.delete",
        origin,
        payload: {
          entryId,
          anilistId,
          ...(current?.mediaListEntryId !== undefined && {
            mediaListEntryId: current.mediaListEntryId,
          }),
        },
      });
    }

    const timestamp = now();
    host.ctx.storage.sql.exec(
      "UPDATE canonical_entries SET tombstoned_at = ?, updated_at = ? WHERE id = ?",
      timestamp,
      timestamp,
      entryId,
    );
    host.ctx.storage.sql.exec("DELETE FROM md_status_queue WHERE entry_id = ?", entryId);
    appendEvent(host, entryId, "list.nuke", origin, {
      ...(anilistId !== undefined && { anilistId }),
    });

    return readListState(host, entryId);
  });
}

export function listEvents(host: SyncHost, entryId: string | undefined, limit = 100) {
  const total =
    (entryId
      ? host.ctx.storage.sql.exec<{ total: number }>(
          "SELECT COUNT(*) AS total FROM list_events WHERE entry_id = ?",
          entryId,
        )
      : host.ctx.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM list_events")
    ).toArray()[0]?.total ?? 0;

  const events = (
    entryId
      ? host.ctx.storage.sql
          .exec<ListEventRow>(
            `SELECT * FROM list_events WHERE entry_id = ? ORDER BY id DESC LIMIT ?`,
            entryId,
            Math.min(500, Math.max(1, limit)),
          )
          .toArray()
      : host.ctx.storage.sql
          .exec<ListEventRow>(
            `SELECT * FROM list_events ORDER BY id DESC LIMIT ?`,
            Math.min(500, Math.max(1, limit)),
          )
          .toArray()
  ).map((row) => toListEvent(row));

  return { events, total };
}

export function enqueueMalBackup(
  host: SyncHost,
  entryId: string,
  changes: SetListStateInput,
): void {
  const previous = host.ctx.storage.sql
    .exec<OpRow>(
      `SELECT * FROM sync_ops WHERE kind = 'mal.status'
     AND json_extract(payload, '$.entryId') = ? ORDER BY id DESC LIMIT 1`,
      entryId,
    )
    .toArray()[0];

  let prior: Schema.Schema.Type<typeof MalBackupPayload>["backupIdentity"];

  if (previous) {
    // A corrupt prior payload decodes to None: treat it as no prior identity.
    const decoded = Schema.decodeOption(Schema.fromJsonString(MalBackupPayload))(previous.payload);

    if (Option.isSome(decoded)) {
      prior = decoded.value.backupIdentity;
    }
  }

  const identity = changes.backupIdentity ?? prior;
  // Supersede old rows too: a newer update retries the latest state, and
  // successes are not logged, so superseded rows are deleted outright.
  host.ctx.storage.sql.exec(
    `DELETE FROM sync_ops
     WHERE kind = 'mal.status' AND json_extract(payload, '$.entryId') = ?`,
    entryId,
  );
  enqueueOp(host, {
    opId: newId(),
    target: "mal",
    kind: "mal.status",
    origin: "device",
    payload: {
      entryId,
      ...(identity && {
        backupIdentity: {
          anilistId: identity.anilistId,
          titles: [...identity.titles],
          ...(identity.malId && { malId: identity.malId }),
        },
      }),
    },
  });
}
