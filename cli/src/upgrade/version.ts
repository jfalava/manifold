export const parseCliVersion = (value: string): [number, number, number] | undefined => {
  const match = /^(?:cli-v|v)?(\d+)\.(\d+)\.(\d+)$/.exec(value);

  if (!match) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const isNewerVersion = (candidate: string, current: string): boolean => {
  const candidateParts = parseCliVersion(candidate);
  const currentParts = parseCliVersion(current);

  if (!candidateParts || !currentParts) {
    throw new Error(`Cannot compare CLI versions "${current}" and "${candidate}".`);
  }

  // Both tuples always have three parts, so the fallback is never used.
  for (const [index, part] of candidateParts.entries()) {
    const other = currentParts[index] ?? 0;

    if (part > other) {
      return true;
    }

    if (part < other) {
      return false;
    }
  }

  return false;
};
