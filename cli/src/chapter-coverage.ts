/** Comparable chapter positions, not upload counts or the highest chapter number. */
export type ChapterCoverage = {
  readonly unit: "chapters" | "volumes" | "unknown";
  readonly count: number;
  readonly numbers: readonly number[];
};

export const chapterCoverage = (
  entries: readonly {
    readonly chapter?: string | number | null;
    readonly volume?: string | number | null;
  }[],
): ChapterCoverage => {
  const chapters = new Set<number>();
  const volumes = new Set<number>();
  const chapterVolumes = new Map<number, number | undefined>();
  let unknown = false;

  const number = (value: string | number | null | undefined): number | undefined => {
    if (value === undefined || value === null || !/^\d+(?:\.\d+)?$/.test(String(value).trim())) {
      return undefined;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  };

  for (const entry of entries) {
    const chapter = number(entry.chapter);
    const volume = number(entry.volume);

    if (chapter !== undefined) {
      // Numbering that resets each volume is not comparable with absolute chapter numbering.
      if (chapterVolumes.has(chapter) && chapterVolumes.get(chapter) !== volume) {
        unknown = true;
      }

      chapterVolumes.set(chapter, volume);
      chapters.add(chapter);
    } else if (volume !== undefined) {
      volumes.add(volume);
    } else {
      unknown = true;
    }
  }

  const unit =
    unknown || (chapters.size > 0 && volumes.size > 0)
      ? "unknown"
      : chapters.size
        ? "chapters"
        : volumes.size
          ? "volumes"
          : "chapters";

  const numbers = [...(unit === "volumes" ? volumes : chapters)].sort((a, b) => a - b);

  return { unit, count: numbers.length, numbers };
};

/** An unknown/volume-only competitor cannot silently lose to a chapter-packaged edition. */
export const mostCovered = <T extends { readonly coverage?: ChapterCoverage }>(
  candidates: readonly T[],
): readonly T[] => {
  if (candidates.length <= 1) {
    return candidates;
  }

  const covered = candidates.flatMap((candidate) =>
    candidate.coverage?.unit === "chapters" ? [{ candidate, coverage: candidate.coverage }] : [],
  );

  if (covered.length !== candidates.length) {
    return [];
  }

  const maximum = Math.max(...covered.map(({ coverage }) => coverage.count));
  const required = new Set(covered.flatMap(({ coverage }) => coverage.numbers));

  return covered.flatMap(({ candidate, coverage }) => {
    if (coverage.count !== maximum) {
      return [];
    }

    const positions = new Set(coverage.numbers);

    return [...required].every((position) => positions.has(position)) ? [candidate] : [];
  });
};

export const coverageDifference = (current?: ChapterCoverage, proposed?: ChapterCoverage) => {
  if (current?.unit !== "chapters" || proposed?.unit !== "chapters") {
    return null;
  }

  return {
    gained: proposed.numbers.filter((number) => !current.numbers.includes(number)),
    lost: current.numbers.filter((number) => !proposed.numbers.includes(number)),
  };
};

/** Pairwise evidence also explains why incomparable editions were left for review. */
export const coverageComparisons = (
  candidates: readonly { readonly id: string; readonly coverage?: ChapterCoverage }[],
) =>
  candidates.flatMap((current, index) =>
    candidates.slice(index + 1).map((proposed) => ({
      from: current.id,
      to: proposed.id,
      difference: coverageDifference(current.coverage, proposed.coverage),
    })),
  );
