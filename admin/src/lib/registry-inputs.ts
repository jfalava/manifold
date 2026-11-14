/**
 * Input schemas for the server functions in `./registry`. The browser is the
 * caller, so a server function's declared input type is a claim: each one
 * decodes its input here before any of it reaches an API path, query or body.
 */

import { AuthProvider, ListStatus, RegistryProvider, SetListStateInput } from "@manifold/contract";
import { Option, Schema } from "effect";

/** MangaDex manga ids are UUIDs; anything else must not reach an API path. */
const MangaDexId = Schema.String.check(Schema.isUUID());

export const SaveListStateInput = Schema.Struct({
  entryId: Schema.NonEmptyString,
  status: SetListStateInput.fields.status,
  score: SetListStateInput.fields.score,
  notes: SetListStateInput.fields.notes,
  startedAt: SetListStateInput.fields.startedAt,
  completedAt: SetListStateInput.fields.completedAt,
  volumeProgress: SetListStateInput.fields.volumeProgress,
});

export const BindProviderInput = Schema.Struct({
  entryId: Schema.NonEmptyString,
  provider: RegistryProvider,
  externalId: Schema.NonEmptyString,
});

export const UnlinkProviderInput = Schema.Struct({
  entryId: Schema.NonEmptyString,
  provider: RegistryProvider,
});

export const NukeEntryInput = Schema.Struct({ entryId: Schema.NonEmptyString });

export const RetryOpInput = Schema.Struct({ opId: Schema.NonEmptyString });

export const LoadMangaDexLibraryInput = Schema.Struct({ status: Schema.optional(ListStatus) });

export const LoadMangaDexStatsInput = Schema.Struct({ ids: Schema.Array(Schema.String) });

export const SetMangaDexStatusInput = Schema.Struct({
  mangaDexId: MangaDexId,
  status: Schema.Union([ListStatus, Schema.Literal("unset")]),
});

export const ImportAniListTokenInput = Schema.Struct({
  accessToken: Schema.String,
  expiresIn: Schema.optional(Schema.Finite),
});

export const DisconnectAuthInput = Schema.Struct({ provider: AuthProvider });

/**
 * Decode one server-function input, keeping only the declared fields. The
 * error names the function and nothing else: an input can carry a token.
 */
export const decodeInput = <A, I>(
  schema: Schema.ConstraintDecoder<A>,
  name: string,
  input: I,
): A => {
  const untrusted: unknown = input;
  const decoded = Schema.decodeUnknownOption(schema)(untrusted);

  if (Option.isNone(decoded)) {
    throw new Error(`Invalid input for ${name}`);
  }

  return decoded.value;
};
