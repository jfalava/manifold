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
  chapterNumber: Schema.optional(Schema.Number),
  volumeNumber: Schema.optional(Schema.Number),
  provider: Schema.Literal("mangadex"),
  sourceChapterId: Schema.NonEmptyString,
  readAt: Schema.Number
});

export type SyncReadPayload = Schema.Schema.Type<typeof SyncReadPayloadSchema>;

export interface DrainGroup<R extends OutboxRowLike = OutboxRowLike> {
  readonly entryId: string;
  readonly chapters: readonly string[];
  readonly rows: readonly R[];
}

export const groupOutboxForDrain = <R extends OutboxRowLike>(
  rows: readonly R[]
): { groups: readonly DrainGroup<R>[]; invalid: readonly R[] } => {
  const byEntry = new Map<string, { chapters: string[]; rows: R[] }>();
  const invalid: R[] = [];

  for (const row of rows) {
    try {
      const payload = Schema.decodeUnknownSync(SyncReadPayloadSchema)(
        JSON.parse(row.payload)
      );
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

  return {
    groups: [...byEntry].map(([entryId, group]) => ({
      entryId,
      chapters: group.chapters,
      rows: group.rows
    })),
    invalid
  };
};
