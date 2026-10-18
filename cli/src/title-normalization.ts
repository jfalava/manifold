export const normalizeTitle = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const uniqueTitles = (titles: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const title of titles) {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = normalizeTitle(trimmed);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
};
