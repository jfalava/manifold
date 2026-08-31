import { isJsonObject } from "@manifold/json";

export interface EntryData {
  readonly socialImage?: string;
}

export function isEntryData(value: unknown): value is EntryData {
  if (!isJsonObject(value)) {
    return false;
  }
  const image = value.socialImage;
  return image === undefined || typeof image === "string";
}

export function entrySocialImage(data: EntryData): string | undefined {
  const image = data.socialImage;
  return image !== undefined && image.length > 0 ? image : undefined;
}
