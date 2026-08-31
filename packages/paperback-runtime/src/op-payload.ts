import {
  isFiniteNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from "@manifold/json";
import {
  parseAniListReadingStatus,
  type AniListReadingStatus,
} from "./anilist-types.js";
import type { AniListFieldChange } from "./anilist-graphql.js";
import type { PendingSyncOp } from "./api.js";

export type ParsedAniListOp =
  | {
      readonly kind: "anilist.status";
      readonly opId: string;
      readonly anilistId: string;
      readonly status: AniListReadingStatus | null;
    }
  | {
      readonly kind: "anilist.progress";
      readonly opId: string;
      readonly anilistId: string;
      readonly progress: number;
    }
  | {
      readonly kind: "anilist.fields";
      readonly opId: string;
      readonly anilistId: string;
      readonly change: AniListFieldChange;
      readonly mediaListEntryId?: number;
    }
  | {
      readonly kind: "anilist.delete";
      readonly opId: string;
      readonly anilistId: string;
      readonly mediaListEntryId?: number;
    };

const requiredString = (payload: JsonObject, key: string, opId: string): string => {
  const value = payload[key];
  if (!isString(value) || value.trim().length === 0) {
    throw new Error(`op ${opId} has invalid ${key}`);
  }
  return value.trim();
};

const nullableString = (
  payload: JsonObject,
  key: string,
  opId: string,
): string | null | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) {return value;}
  if (!isString(value)) {throw new Error(`op ${opId} has invalid ${key}`);}
  return value;
};

const nullableNumber = (
  payload: JsonObject,
  key: string,
  opId: string,
): number | null | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) {return value;}
  if (!isFiniteNumber(value)) {throw new Error(`op ${opId} has invalid ${key}`);}
  return value;
};

const optionalNumber = (
  payload: JsonObject,
  key: string,
  opId: string,
): number | undefined => {
  const value = nullableNumber(payload, key, opId);
  if (value === null) {throw new Error(`op ${opId} has invalid ${key}`);}
  return value;
};

const optionalListEntryId = (
  payload: JsonObject,
  opId: string,
): number | undefined => {
  const value = optionalNumber(payload, "mediaListEntryId", opId);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`op ${opId} has invalid mediaListEntryId`);
  }
  return value;
};

const statusOrNull = (
  value: JsonValue | undefined,
  opId: string,
): AniListReadingStatus | null | undefined => {
  if (value === undefined || value === null) {return value;}
  if (!isString(value)) {throw new Error(`op ${opId} has invalid status`);}
  const status = parseAniListReadingStatus(value);
  if (status === undefined) {throw new Error(`op ${opId} has invalid status`);}
  return status;
};

export const parsePendingAniListOp = (op: PendingSyncOp): ParsedAniListOp => {
  const payload = op.payload;
  const anilistId = requiredString(payload, "anilistId", op.opId);

  switch (op.kind) {
    case "anilist.status": {
      const status = statusOrNull(payload["status"], op.opId);
      if (status === undefined) {throw new Error(`op ${op.opId} has no status`);}
      return { kind: op.kind, opId: op.opId, anilistId, status };
    }
    case "anilist.progress": {
      const progress = optionalNumber(payload, "progress", op.opId);
      if (progress === undefined) {throw new Error(`op ${op.opId} has no progress`);}
      return { kind: op.kind, opId: op.opId, anilistId, progress };
    }
    case "anilist.fields": {
      const status = statusOrNull(payload["status"], op.opId);
      const score = nullableNumber(payload, "score", op.opId);
      const notes = nullableString(payload, "notes", op.opId);
      const startedAt = nullableString(payload, "startedAt", op.opId);
      const completedAt = nullableString(payload, "completedAt", op.opId);
      const volumeProgress = nullableNumber(payload, "volumeProgress", op.opId);
      const mediaListEntryId = optionalListEntryId(payload, op.opId);
      return {
        kind: op.kind,
        opId: op.opId,
        anilistId,
        change: {
          ...(status !== undefined && { status }),
          ...(score !== undefined && { score }),
          ...(notes !== undefined && { notes }),
          ...(startedAt !== undefined && { startedAt }),
          ...(completedAt !== undefined && { completedAt }),
          ...(volumeProgress !== undefined && { volumeProgress }),
        },
        ...(mediaListEntryId !== undefined && { mediaListEntryId }),
      };
    }
    case "anilist.delete": {
      const mediaListEntryId = optionalListEntryId(payload, op.opId);
      return {
        kind: op.kind,
        opId: op.opId,
        anilistId,
        ...(mediaListEntryId !== undefined && { mediaListEntryId }),
      };
    }
    default:
      throw new Error(`op ${op.opId}: unknown kind ${op.kind}`);
  }
};
