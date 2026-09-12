import { Schema } from "effect";

export interface OutboxRowLike {
  readonly id: number;
  readonly payload: string;
  readonly attempts: number;
}

const SyncReadPayloadSchema = Schema.Struct({
  entryId: Schema.NonEmptyString,
  eventId: Schema.NonEmptyString,
  chapterKey: Schema.NonEmptyString,
  chapterNumber: Schema.optional(Schema.Finite),
  volumeNumber: Schema.optional(Schema.Finite),
  provider: Schema.Literal("mangadex"),
  sourceChapterId: Schema.NonEmptyString,
  readAt: Schema.Finite,
});

export type SyncReadPayload = Schema.Schema.Type<typeof SyncReadPayloadSchema>;

export interface DrainGroup<R extends OutboxRowLike = OutboxRowLike> {
  readonly entryId: string;
  readonly chapters: readonly string[];
  readonly rows: readonly R[];
}

export interface DrainBatch<R extends OutboxRowLike = OutboxRowLike> {
  readonly groups: readonly DrainGroup<R>[];
  readonly invalid: readonly R[];
}

export const groupOutboxForDrain = <R extends OutboxRowLike>(rows: readonly R[]): DrainBatch<R> => {
  const byEntry = new Map<string, { chapters: string[]; rows: R[] }>();
  const invalid: R[] = [];

  for (const row of rows) {
    try {
      const payload = Schema.decodeUnknownSync(SyncReadPayloadSchema)(JSON.parse(row.payload));
      const group = byEntry.get(payload.entryId) ?? { chapters: [], rows: [] };
      if (!group.chapters.includes(payload.sourceChapterId)) {
        group.chapters.push(payload.sourceChapterId);
      }
      group.rows.push(row);
      byEntry.set(payload.entryId, group);
    } catch {
      invalid.push(row);
    }
  }

  const groups: DrainGroup<R>[] = [];
  for (const [entryId, group] of byEntry) {
    groups.push({
      entryId,
      chapters: group.chapters,
      rows: group.rows,
    });
  }
  return { groups, invalid };
};
