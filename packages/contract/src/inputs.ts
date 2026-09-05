import { Schema } from "effect";

import {
  CanonicalProvider,
  ChapterSource,
  ContentProvider,
  ListStatus,
  OpOrigin,
  RegistryProvider,
  UpdateProbeReason,
  UpdateProbeSource,
} from "./literals";

export const SetListStateInput = Schema.Struct({
  status: Schema.optional(Schema.NullOr(ListStatus)),
  score: Schema.optional(Schema.NullOr(Schema.Number)),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  volumeProgress: Schema.optional(Schema.NullOr(Schema.Number)),
  origin: Schema.optional(OpOrigin),
  appliedRemotely: Schema.optional(Schema.Boolean),
});
export type SetListStateInput = Schema.Schema.Type<typeof SetListStateInput>;

export const UpsertEntryInput = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: CanonicalProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
});
export type UpsertEntryInput = Schema.Schema.Type<typeof UpsertEntryInput>;

export const LinkProviderInput = Schema.Struct({
  provider: RegistryProvider,
  externalId: Schema.NonEmptyString,
  title: Schema.optional(Schema.String),
});
export type LinkProviderInput = Schema.Schema.Type<typeof LinkProviderInput>;

export const SetChapterSourceInput = Schema.Struct({
  chapterSource: ChapterSource,
  origin: Schema.optional(OpOrigin),
});
export type SetChapterSourceInput = Schema.Schema.Type<typeof SetChapterSourceInput>;

export const ResolveEntryInput = Schema.Struct({
  provider: RegistryProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
});
export type ResolveEntryInput = Schema.Schema.Type<typeof ResolveEntryInput>;

/**
 * A user-selected provider result. `links` contains only identities proven by
 * provider metadata (for example MangaDex's AniList link), never title guesses.
 */
export const IngestCandidateInput = Schema.Struct({
  provider: RegistryProvider,
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  links: Schema.optional(Schema.Array(LinkProviderInput)),
});
export type IngestCandidateInput = Schema.Schema.Type<typeof IngestCandidateInput>;

export const RecordReadInput = Schema.Struct({
  eventId: Schema.optional(Schema.NonEmptyString),
  chapterKey: Schema.NonEmptyString,
  chapterNumber: Schema.optional(Schema.Number),
  volumeNumber: Schema.optional(Schema.Number),
  provider: Schema.optional(ContentProvider),
  sourceChapterId: Schema.optional(Schema.NonEmptyString),
  readAt: Schema.optional(Schema.Number),
});
export type RecordReadInput = Schema.Schema.Type<typeof RecordReadInput>;

export const CompleteOpsInput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      opId: Schema.NonEmptyString,
      ok: Schema.Boolean,
      error: Schema.optional(Schema.String),
      mediaListEntryId: Schema.optional(Schema.Number),
    }),
  ),
});
export type CompleteOpsInput = Schema.Schema.Type<typeof CompleteOpsInput>;

export const SetMangaDexStatusInput = Schema.Struct({
  status: Schema.NullOr(ListStatus),
});
export type SetMangaDexStatusInput = Schema.Schema.Type<typeof SetMangaDexStatusInput>;

export const NukeEntryInput = Schema.Struct({
  origin: Schema.optional(OpOrigin),
});
export type NukeEntryInput = Schema.Schema.Type<typeof NukeEntryInput>;

export const UpdateProbeFailureInput = Schema.Struct({
  entryId: Schema.optional(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  source: UpdateProbeSource,
  reason: UpdateProbeReason,
  detail: Schema.optional(Schema.String),
});
export type UpdateProbeFailureInput = Schema.Schema.Type<typeof UpdateProbeFailureInput>;

export const ReportUpdateFailuresInput = Schema.Struct({
  failures: Schema.Array(UpdateProbeFailureInput),
});
export type ReportUpdateFailuresInput = Schema.Schema.Type<typeof ReportUpdateFailuresInput>;

export const MangaDexMatchInput = Schema.Struct({
  id: Schema.NonEmptyString,
  provider: Schema.Literals(["anilist", "mal"]),
  providerId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  persistSearchResults: Schema.optional(Schema.Boolean),
  externalIds: Schema.optional(
    Schema.Struct({
      anilist: Schema.optional(Schema.NonEmptyString),
      mal: Schema.optional(Schema.NonEmptyString),
      mangadex: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  metadata: Schema.optional(
    Schema.Struct({
      chapters: Schema.optional(Schema.Number),
      volumes: Schema.optional(Schema.Number),
      startDate: Schema.optional(Schema.String),
      endDate: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    }),
  ),
});
export type MangaDexMatchInput = Schema.Schema.Type<typeof MangaDexMatchInput>;
