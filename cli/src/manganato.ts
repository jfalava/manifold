/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { createAniListSource } from "@manifold/canonical/sources";
import { errorMessage, manifoldUserAgent, type JsonObject, type JsonValue } from "@manifold/json";
import { isChallengeText, type BrowserView } from "@/browser-view";
import type { ChapterCoverage } from "@/chapter-coverage";
import { cliError, epochMillisNow, platformFetch, runHost, sleepPromise } from "@/effect-kit";
import { providerIdOf } from "@/registry-titles";

export const MANGANATO_ORIGIN = "https://www.manganato.gg";
export const MANGANATO_SEARCH_POLICY = 7;
export const MANGANATO_SELECTION_POLICY = 11;

const SearchPage = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, title: Schema.NonEmptyString })),
  next: Schema.NullOr(Schema.String),
});
const Details = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  authors: Schema.Array(Schema.String),
});
export type ManganatoDetails = Schema.Schema.Type<typeof Details>;
export type ManganatoCandidate = ManganatoDetails & {
  readonly coverage?: ChapterCoverage & { readonly latestChapterUpdatedAt?: number };
};
export type ManganatoSelection = ManganatoCandidate & {
  readonly selection?: {
    readonly basis: "active-listing";
    readonly lostPositions: readonly {
      readonly candidateId: string;
      readonly numbers: readonly number[];
    }[];
  };
};
type ManganatoCoverage = ChapterCoverage & {
  readonly latestChapterUpdatedAt?: number;
  readonly inventory: {
    readonly rawRecords: number;
    readonly duplicateRecords: number;
    readonly excludedNegativeRecords: number;
    readonly normalizedRecords: number;
  };
};
const ChapterPage = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    chapters: Schema.Array(
      Schema.Struct({
        chapter_slug: Schema.NonEmptyString,
        chapter_num: Schema.NullOr(Schema.Union([Schema.String, Schema.Finite])),
        updated_at: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
    pagination: Schema.Struct({
      total: Schema.Int,
      limit: Schema.Int,
      offset: Schema.Int,
      has_more: Schema.Boolean,
    }),
  }),
});
export interface ManganatoIdentity {
  readonly titles: readonly string[];
  readonly authors: readonly string[];
  readonly confirmedCandidateIds?: readonly string[];
  readonly preferredCandidateId?: string;
  readonly manualReview?: boolean;
  readonly chapterReference?: ManganatoChapterReference;
}

export interface ManganatoChapterReference {
  readonly provider: "anilist";
  readonly providerId: string;
  readonly titles: readonly string[];
  readonly chapters: number | null;
  readonly status: string | null;
}

export class ManganatoBlockedError extends Data.TaggedError("ManganatoBlockedError")<{
  readonly message: string;
  readonly reason?: "timeout";
}> {}

export class ManganatoPageBudgetError extends Data.TaggedError("ManganatoPageBudgetError")<{
  readonly message: string;
}> {}

// Keep all letters/numbers, including edition suffixes. Only spacing, punctuation and accents vary.
const titleKey = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

const authorKey = (value: string): string =>
  value
    .replace(/\([^)]*\)/g, "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");

// User-confirmed full-author aliases. Do not generalize these spellings to other authors.
const authorAliases = new Map(
  [
    ["Sano Yuto", "Yuuto Sano"],
    ["Ohtsuki Ichika", "Ootsuki Ichika"],
    ["Matsuena Shun", "Syun Matsuena"],
    ["Maijo Ohtaro", "Maijou Outarou"],
    ["Yoneshiro Kyou", "Kyo Yoneshiro"],
    ["Atou Rie", "Ato Rie"],
    ["Ookubo Atsushi", "Ohkubo Atsushi"],
    ["Soumatou", "Somato"],
    ["Naito Marcey", "Naitou Marcey"],
    ["Kitou Sakeru", "Sakeru Kito"],
    ["Ohno Tsutomu", "Tsutomu Oono"],
    ["Necoco", "Nekoko"],
  ].map(([primary, alias]) => [authorKey(alias!), authorKey(primary!)]),
);

const missingAuthorKeys = new Set(["unknown", "updating", "n a"]);

// User-reviewed work/listing pairs, keyed by the bound AniList ID, not a title search.
const confirmedWorks = new Map<
  string,
  {
    readonly titles: readonly string[];
    readonly ids: readonly string[];
    readonly preferredCandidateId?: string;
  }
>([
  ["139415", { titles: ["Kichiku Eiyuu", "Savage Hero"], ids: ["kichiku-eiyuu", "savage-hero"] }],
  ["189568", { titles: ["Nigasanai yo? Fukuroji-kun"], ids: ["nigasanai-yo-fukuroji-kun"] }],
  ["121426", { titles: ["Yumemi ga Oka Wonderland"], ids: ["yumemi-ga-oka-wonderland"] }],
  [
    "188743",
    {
      titles: ["Marika's Love Meter Malfunction", "Marika-chan no Koukando wa Bukkowareteiru"],
      ids: ["marika-chan-no-koukando-wa-bukkowareteiru", "marikas-love-meter-malfunction"],
    },
  ],
  ["114528", { titles: ["Ii Fuufu no Hanashi.", "A Happy Couple"], ids: ["a-happy-couple"] }],
  [
    "104266",
    {
      titles: [
        "Yuki Nee-chan no Kannou Gokko.",
        "Yuki Nee-chan no Kan-nou Gokko",
        "Yuki-neechan no Kannou-gokko.",
      ],
      ids: ["yuki-nee-chan-no-kan-nou-gokko", "yuki-neechan-no-kannou-gokko"],
    },
  ],
  [
    "208491",
    {
      titles: ["Ore no Ichizu wo Jama Suru Aitsu", "Ore no Ichizu o Jama Suru Aitsu"],
      ids: ["ore-no-ichizu-wo-jama-suru-aitsu", "ore-no-ichizu-o-jama-suru-aitsu"],
    },
  ],
  [
    "157391",
    {
      titles: ["Dark Summoner to Dekiteiru", "I'm Dating a Dark Summoner"],
      ids: ["dark-summoner-to-dekiteiru", "i-m-dating-a-dark-summoner"],
    },
  ],
  [
    "212891",
    {
      titles: ["Himegoto Kakushigoto", "Secret Affairs, Hidden Truths"],
      ids: ["himegoto-kakushigoto", "secret-affairs-hidden-truths"],
    },
  ],
  [
    "210954",
    {
      titles: ["Mada Kimi wo Miageteru", "Mada Kimi o Miageteru", "I'm Still Looking Up At You"],
      ids: ["mada-kimi-o-miageteru", "im-still-looking-up-at-you"],
    },
  ],
  [
    "153502",
    {
      titles: ["Konsei wa Goen ga Arimasu you ni!", "Quinpath Romance"],
      ids: ["quinpath-romance"],
      // User reported broken chapter images on the romanized listing.
      preferredCandidateId: "quinpath-romance",
    },
  ],
  [
    "130872",
    {
      titles: ["Fuzoroi no Renri"],
      ids: ["fuzoroi-no-renri"],
      // Explicit listing choice; side stories are not confirmed as the same edition.
      preferredCandidateId: "fuzoroi-no-renri",
    },
  ],
  [
    "177188",
    {
      titles: ["My Girlfriend Is a Colossal Cutie", "Boku No Kanojo Wa Dekkawaii"],
      ids: ["boku-no-kanojo-wa-dekkawaii", "my-girlfriend-is-a-colossal-cutie"],
    },
  ],
  ["135427", { titles: ["Hotel Inhumans"], ids: ["hotel-inhumans"] }],
  ["85978", { titles: ["The New Gate"], ids: ["the-new-gate"] }],
  [
    "194023",
    {
      titles: ["Kuma to Usagi wa Tomodachi dewa Irarenai"],
      ids: [
        "kuma-to-usagi-wa-tomodachi-de-wa-irarenai",
        "kuma-to-usagi-wa-tomodachi-dewa-irarenai",
      ],
    },
  ],
  [
    "192691",
    {
      titles: ["Mikoto-chan wa Kirawaretakunai!", "Mikoto-chan Doesn't Want to Be Hated!"],
      ids: ["mikoto-chan-wa-kirawaretakunai", "mikoto-chan-doesn-t-want-to-be-hated"],
    },
  ],
  [
    "204271",
    {
      titles: ["Haha no Ai wa Mama Naranai!", "My Stepmother's Love Isn't Going How I Thought!"],
      ids: ["haha-no-ai-wa-mama-naranai", "my-stepmothers-love-isnt-going-how-i-thought"],
    },
  ],
  [
    "153669",
    {
      titles: ["Assassin & Cinderella", "Assassin × Cinderella"],
      ids: ["assassin-cinderella", "assassin-x-cinderella"],
    },
  ],
  [
    "176604",
    {
      titles: [
        "Moto Azadarake no Kanojo ga Shinpai de",
        "I'm Worried About My Girlfriend, Who Used to be Covered in Bruises",
      ],
      ids: [
        "moto-azadarake-no-kanojo-ga-shinpai-de",
        "i-m-worried-about-my-girlfriend-who-used-to-be-covered-in-bruises",
      ],
    },
  ],
  [
    "163643",
    {
      titles: [
        "The Erotical Wizard and His Twelve Brides",
        "Erotical Wizard to 12-nin no Hanayome",
      ],
      ids: ["the-erotical-wizard-and-his-twelve-brides", "erotical-wizard-to-12-nin-no-hanayome"],
    },
  ],
  [
    "117964",
    {
      titles: [
        "Garbage Brave: Isekai ni Shoukan Sare Suterareta Yuusha no Fukushuu Monogatari",
        "Garbage Hero: A Revenge Story of a Hero Who Got Summoned to Another World",
      ],
      ids: [
        "garbage-brave-isekai-ni-shoukan-sare-suterareta-yuusha-no-fukushuu-monogatari",
        "garbage-hero-a-revenge-story-of-a-hero-who-got-summoned-to-another-world",
      ],
    },
  ],
  [
    "188228",
    {
      titles: [
        "Koisuru Futari wa Kiba wo Kakusu: Gap ga Arisugiru Couple no Hanashi",
        "Koisuru Futari wa Kiba o Kakusu: Gap ga Arisugiru Couple no Hanashi",
      ],
      ids: [
        "koisuru-futari-wa-kiba-wo-kakusu-gap-ga-arisugiru-couple-no-hanashi",
        "koisuru-futari-wa-kiba-o-kakusu-gap-ga-arisugiru-couple-no-hanashi",
      ],
    },
  ],
  [
    "209708",
    {
      titles: [
        "Tatakai Shika Shiranai Onna Kishi wo Amayakashi Tsuzuketa",
        "Tatakai Shika Shiranai Onna Kishi o Amayakashi Tsuzuketa",
      ],
      ids: [
        "tatakai-shika-shiranai-onna-kishi-o-amayakashi-tsuzuketa",
        "tatakai-shika-shiranai-onna-kishi-wo-amayakashi-tsuzuketa",
      ],
    },
  ],
  [
    "168335",
    {
      titles: [
        "Otaku ni Tsumetai Gal",
        "A Gyaru Who's Cold to Otaku",
        "The Gyaru Who's Cold to Otaku",
      ],
      ids: ["a-gyaru-who-s-cold-to-otaku", "the-gyaru-who-s-cold-to-otaku"],
    },
  ],
  [
    "174999",
    {
      titles: [
        "Mainichi Ie ni Kuru Gal ga Kyorikan Zero demo Yasashikunai",
        "The Gal Who Comes to My House Every Day Has Zero Boundaries but Isn't Kind",
      ],
      ids: [
        "mainichi-ie-ni-kuru-gal-ga-kyorikan-zero-demo-yasashikunai",
        "mainichi-ie-ni-kuru-gal-ga-kyorikan-zero-demo-yasashiku-nai",
        "the-gal-who-comes-to-my-house-every-day-has-zero-boundaries-but-isn-t-kind",
      ],
    },
  ],
  [
    "181995",
    {
      titles: ["Cool na Doukyuusei no 10-nengo", "Cool na Doukyuusei no ◯◯ Nengo…"],
      ids: ["cool-na-doukyuusei-no-oo-nengo", "cool-na-doukyuusei-no-10-nengo"],
    },
  ],
  [
    "133837",
    {
      titles: ["Demon X Angel Can't Get Along!"],
      ids: ["demon-x-angel-can-t-get-along", "demon-x-angel-cant-get-along"],
    },
  ],
]);

export const hasManganatoTitle = (titles: readonly string[], names: readonly string[]): boolean => {
  const keys = new Set(titles.map(titleKey).filter(Boolean));
  return names.some((name) => keys.has(titleKey(name)));
};

export const hasManganatoAuthor = (
  expected: readonly string[],
  actual: readonly string[],
): boolean => {
  const keyFor = (value: string): string => {
    const key = authorKey(value);
    return authorAliases.get(key) ?? key;
  };
  const keys = new Set(expected.map(keyFor).filter((key) => key && !missingAuthorKeys.has(key)));
  return actual.some((author) => keys.has(keyFor(author)));
};

const chapterPositions = (candidate: ManganatoCandidate): ReadonlySet<number> =>
  new Set(
    candidate.coverage?.unit === "chapters"
      ? candidate.coverage.numbers.filter((number) => number >= 1 && Number.isInteger(number))
      : [],
  );

// A maximum alone can be a bogus numbered upload. Require every integer from 1 through it.
const denseChapterRun = (candidate: ManganatoCandidate): boolean => {
  const positions = chapterPositions(candidate);
  return positions.size > 0 && Math.max(...positions) === positions.size;
};

// Primary titles can expose editions that upstream aliases conflate.
const editionKey = (title: string): string =>
  (
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .match(
        /\b(?:side\s*stor(?:y|ies)|spin\s*off|pre\s*serialization|one\s*shot|novel|anthology|sequel|remake|full\s*colou?r)\b/gi,
      ) ?? []
  )
    .map(titleKey)
    .sort()
    .join("|");

/** Evidence points are policy weights, not probabilities. Chapter support never subtracts points. */
export const manganatoMatchEvidence = (
  identity: ManganatoIdentity,
  candidate: ManganatoCandidate,
  candidates: readonly ManganatoCandidate[] = [],
) => {
  const names = [candidate.title, ...candidate.aliases];
  const exactTitle = hasManganatoTitle(identity.titles, names);
  const userConfirmed = identity.confirmedCandidateIds?.includes(candidate.id) ?? false;
  const credited = (authors: readonly string[]): boolean =>
    authors.some((author) => {
      const key = authorKey(author);
      return key.length > 0 && !missingAuthorKeys.has(key);
    });
  const author = hasManganatoAuthor(identity.authors, candidate.authors)
    ? "verified"
    : credited(identity.authors) && credited(candidate.authors)
      ? "different"
      : "missing";
  const reference = identity.chapterReference;
  const positions = chapterPositions(candidate);
  const buckets = new Set(
    candidate.coverage?.unit === "chapters"
      ? candidate.coverage.numbers.filter((number) => number >= 1).map(Math.floor)
      : [],
  );
  const lastChapter = Math.max(0, ...buckets);
  const total = reference?.chapters;
  // Finished totals are comparable only with dense, near-complete absolute numbering.
  // Fractions collapse for this signal, but keep their original positions for coverage ranking.
  const canonicalChapterSupport =
    reference?.status === "FINISHED" &&
    total !== null &&
    total !== undefined &&
    Number.isSafeInteger(total) &&
    total >= 10 &&
    hasManganatoTitle(reference.titles, names) &&
    candidate.coverage?.unit === "chapters" &&
    buckets.has(1) &&
    buckets.size >= total * 0.95 &&
    buckets.size <= total * 1.05 &&
    lastChapter <= total * 1.05 &&
    buckets.size >= lastChapter * 0.95;
  // Only directly author-verified listings can anchor another candidate. Never chain rescues.
  const overlap =
    (author === "different" || author === "missing") && exactTitle
      ? candidates
          .flatMap((anchor) => {
            if (
              anchor.id === candidate.id ||
              !hasManganatoTitle(identity.titles, [anchor.title, ...anchor.aliases]) ||
              !hasManganatoAuthor(identity.authors, anchor.authors)
            ) {
              return [];
            }
            const anchorPositions = chapterPositions(anchor);
            const shared = [...positions].filter((number) => anchorPositions.has(number)).length;
            const smaller = Math.min(positions.size, anchorPositions.size);
            return shared >= 10 && shared >= smaller * 0.95
              ? [
                  {
                    anchorId: anchor.id,
                    shared,
                    candidateIntegers: positions.size,
                    anchorIntegers: anchorPositions.size,
                    smaller,
                    fraction: shared / smaller,
                    minimumShared: 10,
                    minimumFraction: 0.95,
                  },
                ]
              : [];
          })
          .sort((a, b) => a.anchorId.localeCompare(b.anchorId))
      : [];
  // Missing-credit overlaps are report evidence only, never automatic eligibility.
  const chapterSupport = canonicalChapterSupport || (author !== "missing" && overlap.length > 0);
  // Joined/split spellings can suggest an alias, but never verify it automatically.
  const authorAliasSuggestions =
    author === "different"
      ? [...new Set(identity.authors)].flatMap((expected) =>
          [...new Set(candidate.authors)].flatMap((actual) => {
            const left = authorKey(expected);
            const right = authorKey(actual);
            return left &&
              right &&
              left !== right &&
              left.replaceAll(" ", "") === right.replaceAll(" ", "")
              ? [{ expected, actual, status: "unconfirmed" }]
              : [];
          }),
        )
      : [];
  const score =
    (exactTitle ? 60 : 0) +
    (author === "verified" || userConfirmed ? 40 : 0) +
    (chapterSupport ? 25 : 0);
  return {
    author,
    exactTitle,
    userConfirmed,
    chapterSupport,
    canonicalChapterSupport,
    overlap,
    authorAliasSuggestions,
    chapterBuckets: buckets.size,
    lastChapter,
    score,
    eligible:
      !identity.manualReview &&
      exactTitle &&
      (userConfirmed || author !== "missing") &&
      score >= 85,
  };
};

export const selectManganatoCandidate = (
  identity: ManganatoIdentity,
  candidates: readonly ManganatoCandidate[],
): ManganatoSelection | undefined => {
  if (identity.manualReview) {
    return undefined;
  }
  // An explicit listing choice overrides ranking, but never identity checks or falls back.
  if (identity.preferredCandidateId) {
    return candidates.find(
      (candidate) =>
        candidate.id === identity.preferredCandidateId &&
        manganatoMatchEvidence(identity, candidate).eligible,
    );
  }
  const plausible = [
    ...new Map(
      candidates
        .filter((candidate) =>
          hasManganatoTitle(identity.titles, [candidate.title, ...candidate.aliases]),
        )
        .map((candidate) => [candidate.id, candidate]),
    ).values(),
  ];
  // Every competitor needs enough evidence; an unresolved listing cannot silently lose.
  if (
    !plausible.length ||
    plausible.some((item) => !manganatoMatchEvidence(identity, item, plausible).eligible)
  ) {
    return undefined;
  }
  if (plausible.length === 1) {
    return plausible[0];
  }
  // MangaNato checks containment below, with its own reviewed active-listing exception.
  if (plausible.some((item) => item.coverage?.unit !== "chapters")) {
    return undefined;
  }
  const maximum = Math.max(...plausible.map((item) => item.coverage!.count));
  const winners = plausible.filter((item) => item.coverage!.count === maximum);
  if (!winners.length || !winners[0]!.coverage!.count) {
    return undefined;
  }
  const positions = new Set(winners[0]!.coverage!.numbers);
  // A higher count must not hide chapters available only in a competing listing.
  if (plausible.some((item) => item.coverage!.numbers.some((number) => !positions.has(number)))) {
    if (
      plausible.some(
        (item) =>
          editionKey(item.title) !== editionKey(identity.titles[0] ?? "") ||
          !Number.isFinite(item.coverage!.latestChapterUpdatedAt) ||
          item.coverage!.latestChapterUpdatedAt! <= 0,
      )
    ) {
      return undefined;
    }
    const active = plausible.find((item) => {
      if (!denseChapterRun(item)) {
        return false;
      }
      const integers = chapterPositions(item);
      return plausible.every((other) => {
        if (other.id === item.id) {
          return true;
        }
        const otherIntegers = chapterPositions(other);
        return (
          integers.size > otherIntegers.size &&
          [...otherIntegers].every((number) => integers.has(number)) &&
          item.coverage!.latestChapterUpdatedAt! > other.coverage!.latestChapterUpdatedAt!
        );
      });
    });
    if (!active) {
      return undefined;
    }
    const available = new Set(active.coverage!.numbers);
    return {
      ...active,
      selection: {
        basis: "active-listing",
        lostPositions: plausible
          .filter((item) => item.id !== active.id)
          .map((item) => ({
            candidateId: item.id,
            numbers: item.coverage!.numbers.filter((number) => !available.has(number)),
          }))
          .filter((item) => item.numbers.length > 0),
      },
    };
  }
  if (winners.length === 1) {
    return winners[0];
  }
  if (
    winners.some(
      (item) =>
        !Number.isFinite(item.coverage!.latestChapterUpdatedAt) ||
        item.coverage!.latestChapterUpdatedAt! <= 0,
    )
  ) {
    return undefined;
  }
  const latest = Math.max(...winners.map((item) => item.coverage!.latestChapterUpdatedAt!));
  const newest = winners.filter((item) => item.coverage!.latestChapterUpdatedAt === latest);
  return newest.length === 1 ? newest[0] : undefined;
};

/** Hypothetical identity evidence. Acceptance is explicit and never changes real eligibility. */
export const recommendManganatoCandidate = (
  identity: ManganatoIdentity,
  candidates: readonly ManganatoCandidate[],
) => {
  if (identity.manualReview || identity.preferredCandidateId || candidates.length < 2) {
    return undefined;
  }
  const edition = editionKey(identity.titles[0] ?? "");
  if (candidates.some((candidate) => editionKey(candidate.title) !== edition)) {
    return undefined;
  }
  const inferred = [];
  for (const candidate of candidates) {
    const evidence = manganatoMatchEvidence(identity, candidate, candidates);
    if (!evidence.exactTitle) {
      return undefined;
    }
    if (evidence.eligible) {
      continue;
    }
    if (evidence.author !== "missing" || !evidence.overlap.length) {
      return undefined;
    }
    inferred.push({ candidateId: candidate.id, overlap: evidence.overlap });
  }
  if (!inferred.length) {
    return undefined;
  }
  // Reuse coverage and recency ranking on a local hypothetical identity. Do not
  // expose its eligibility as real confirmation or change the caller's identity.
  const winner = selectManganatoCandidate(
    {
      ...identity,
      confirmedCandidateIds: [
        ...(identity.confirmedCandidateIds ?? []),
        ...inferred.map((item) => item.candidateId),
      ],
    },
    candidates,
  );
  if (!winner) {
    return undefined;
  }
  return {
    candidateId: winner.id,
    basis:
      manganatoMatchEvidence(identity, winner, candidates).author === "verified"
        ? "author-verified"
        : "missing-credit-inference",
    inferred,
    requiresOptIn: true,
    acceptEligible: denseChapterRun(winner),
    selection: winner.selection ?? null,
  };
};

// MangaNato ORs query words, so discovery uses single words, not multiword narrowing.
const broadSearchWords = new Set(
  "the and with from into that this have will wants want make love world sister sisters reincarnated reincarnation villainess heroine hero harem manga watashi sekai tensei shita suru another young again law".split(
    " ",
  ),
);
const fallbackSearchWords = new Set(
  "welcome home back start boss household prince wife class friend friends senior senpai tomodachi".split(
    " ",
  ),
);
const compareSearchWords = (a: string, b: string): number =>
  Number(fallbackSearchWords.has(a)) - Number(fallbackSearchWords.has(b)) || b.length - a.length;

const manganatoSearchWords = (title: string): readonly string[] => {
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(title)) {
    return [];
  }
  return [
    ...new Set(
      title
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [],
    ),
  ]
    .filter((word) => !broadSearchWords.has(word) && (word.length >= 3 || /^\d+$/.test(word)))
    .sort(compareSearchWords);
};

/** Rank up to three Latin title variants by their most distinctive available word. */
export const manganatoSearchPlans = (
  titles: readonly string[],
): readonly {
  readonly title: string;
  readonly queries: readonly string[];
}[] => {
  const seen = new Set<string>();
  return titles
    .flatMap((title) => {
      const queries = manganatoSearchWords(title).slice(0, 2);
      // Near-identical romanizations often produce the same search; do not spend another alias slot.
      const key = [...queries].sort().join("|");
      if (!key || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{ title, queries }];
    })
    .sort((a, b) => compareSearchWords(a.queries[0]!, b.queries[0]!))
    .slice(0, 3);
};

/** Try unsearched canonical words without letting one long title consume the rescue budget. */
export const manganatoRescueQueries = (
  titles: readonly string[],
  plannedQueries: readonly string[],
): readonly string[] => {
  const seen = new Set(plannedQueries);
  const seenTitles = new Set<string>();
  const words = titles
    .map((title) => manganatoSearchWords(title).filter((word) => !seen.has(word)))
    .filter((titleWords) => {
      const key = titleWords.join("|");
      if (!key || seenTitles.has(key)) {
        return false;
      }
      seenTitles.add(key);
      return true;
    });
  const queries: string[] = [];
  while (queries.length < 6) {
    const previousCount = queries.length;
    for (const titleWords of words) {
      const query = titleWords.find((word) => !seen.has(word));
      if (!query) {
        continue;
      }
      seen.add(query);
      queries.push(query);
      if (queries.length === 6) {
        return queries;
      }
    }
    if (queries.length === previousCount) {
      break;
    }
  }
  return queries;
};

const MangaDexIdentity = Schema.Struct({
  data: Schema.Struct({
    attributes: Schema.Struct({
      title: Schema.Record(Schema.String, Schema.String),
      altTitles: Schema.Array(Schema.Record(Schema.String, Schema.String)),
    }),
    relationships: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        attributes: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
      }),
    ),
  }),
});

export const loadManganatoIdentity = async (
  row: {
    readonly title: string;
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  onProgress: (message: string) => void,
  onIncomplete?: () => void,
): Promise<
  ManganatoIdentity & {
    readonly discoveryTitles: readonly string[];
    readonly fallbackTitles: readonly string[];
  }
> => {
  const anilistId = providerIdOf(row, "anilist");
  const confirmed = confirmedWorks.get(anilistId ?? "");
  const reviewed = {
    ...(confirmed && { confirmedCandidateIds: confirmed.ids }),
    ...(confirmed?.preferredCandidateId && {
      preferredCandidateId: confirmed.preferredCandidateId,
    }),
    // Publication rename with competing updating versions. Never choose automatically.
    ...(anilistId === "149329" && { manualReview: true }),
  };
  const knownTitles = [row.title, ...(confirmed?.titles ?? [])];
  const id = providerIdOf(row, "mangadex");
  if (!id) {
    onProgress("No MangaDex author evidence; title-only candidates will need review");
    return {
      ...reviewed,
      titles: knownTitles,
      discoveryTitles: knownTitles,
      fallbackTitles: knownTitles,
      authors: [],
    };
  }
  onProgress("Loading MangaDex aliases and author/artist credits (20s timeout)");
  try {
    const response = await platformFetch(
      `https://api.mangadex.org/manga/${encodeURIComponent(id)}?includes[]=author&includes[]=artist`,
      {
        headers: { "user-agent": manifoldUserAgent("cli") },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw cliError(`MangaDex HTTP ${response.status}`);
    }
    const { data } = await runHost(
      Schema.decodeUnknownEffect(MangaDexIdentity)(await response.json()),
    );
    const aliases = [
      ...Object.entries(data.attributes.title),
      ...data.attributes.altTitles.flatMap((titles) => Object.entries(titles)),
    ];
    // Search English/romanized aliases only. Other translations still count as identity evidence.
    const discoveryTitles = aliases
      .filter(([language]) => ["en", "ja-ro", "ko-ro", "zh-ro"].includes(language))
      .map(([, title]) => title);
    // Without tagged aliases the registry title is the only discovery evidence available.
    if (!discoveryTitles.length) {
      discoveryTitles.push(row.title);
    }
    const seen = new Set<string>();
    const titles = [...knownTitles, ...aliases.map(([, title]) => title)].filter((title) => {
      const key = titleKey(title);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return {
      ...reviewed,
      titles,
      discoveryTitles,
      // Keep canonical names independent of the ranked word-search alias cutoff.
      fallbackTitles: [
        row.title,
        ...["en", "ja-ro", "ko-ro", "zh-ro"].flatMap((language) => {
          const title =
            data.attributes.title[language] ?? aliases.find(([tag]) => tag === language)?.[1];
          return title ? [title] : [];
        }),
      ],
      authors: data.relationships.flatMap((link) =>
        ["author", "artist"].includes(link.type) && link.attributes?.name
          ? [link.attributes.name]
          : [],
      ),
    };
  } catch (error) {
    onIncomplete?.();
    onProgress(
      `MangaDex metadata unavailable: ${error instanceof Error ? error.message : String(error)}; no automatic title-only links`,
    );
    return {
      ...reviewed,
      titles: knownTitles,
      discoveryTitles: knownTitles,
      fallbackTitles: knownTitles,
      authors: [],
    };
  }
};

let lastChapterReferenceAt = 0;

/** Read only the bound work; never search for a total that happens to fit a candidate. */
export const loadManganatoChapterReference = async (
  row: {
    readonly providers: readonly { readonly provider: string; readonly externalId: string }[];
  },
  onProgress: (message: string) => void,
  onIncomplete: () => void,
): Promise<ManganatoChapterReference | undefined> => {
  const anilistId = providerIdOf(row, "anilist");
  const malId = providerIdOf(row, "mal");
  if (!anilistId && !malId) {
    return undefined;
  }
  try {
    if ([anilistId, malId].some((id) => id !== undefined && !/^[1-9]\d*$/.test(id))) {
      throw cliError("Invalid bound AniList/MAL ID");
    }
    onProgress("Loading bound AniList chapter evidence (20s timeout)");
    const source = createAniListSource({
      userAgent: manifoldUserAgent("cli"),
      fetcher: async (input, init) => {
        const wait = 2_500 - (epochMillisNow() - lastChapterReferenceAt);
        if (wait > 0) {
          await sleepPromise(wait);
        }
        lastChapterReferenceAt = epochMillisNow();
        return platformFetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
      },
    });
    const entry = await runHost(
      (anilistId ? source.getById(anilistId) : source.getByIdMal!(malId!)).pipe(
        Effect.timeout("20 seconds"),
      ),
    );
    const mangadexId = providerIdOf(row, "mangadex");
    if (
      !entry ||
      (anilistId !== undefined && entry.providerId !== anilistId) ||
      (malId !== undefined && entry.externalIds?.mal !== malId) ||
      (mangadexId !== undefined &&
        entry.externalIds?.mangadex !== undefined &&
        entry.externalIds.mangadex.toLowerCase() !== mangadexId.toLowerCase())
    ) {
      throw cliError("Bound canonical IDs do not agree with chapter reference");
    }
    return {
      provider: "anilist",
      providerId: entry.providerId,
      titles: [entry.title, ...entry.aliases],
      chapters: entry.metadata?.chapters ?? null,
      status: entry.metadata?.status ?? null,
    };
  } catch (error) {
    onIncomplete();
    onProgress(
      `Canonical chapter evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
};

// Remove only machine-precision tails near a short decimal, never round every chapter to parts.
const normalizeChapterNumber = (number: number): number => {
  const tolerance = Math.min(1e-12, Number.EPSILON * Math.abs(number) * 2);
  for (let places = 0; places <= 12; places++) {
    const rounded = Number(number.toFixed(places));
    if (Math.abs(number - rounded) <= tolerance) {
      return rounded;
    }
  }
  return number;
};

/** Catalog reads run inside an already-cleared Chrome tab; cookies never leave Chrome. */
export const createManganatoClient = (options: {
  readonly view: BrowserView;
  readonly delay: number;
  readonly maxPages: number;
  readonly onProgress?: (message: string) => void;
  readonly catalog?: readonly JsonObject[];
  readonly onCache?: (record: JsonObject) => void;
  readonly onBlocked?: (error: ManganatoBlockedError) => Promise<void>;
}) => {
  let requested = false;
  const cache = new Map<
    string,
    { readonly savedAt: number; readonly data: readonly ManganatoDetails[] }
  >();
  const pages = new Map<
    string,
    { readonly savedAt: number; readonly data: Schema.Schema.Type<typeof SearchPage> }
  >();
  const inventories = new Map<
    string,
    { readonly savedAt: number; readonly data: Schema.Schema.Type<typeof ChapterPage> }
  >();
  const CatalogRecord = Schema.Struct({
    event: Schema.Literal("catalog"),
    version: Schema.Literal(1),
    origin: Schema.Literal(MANGANATO_ORIGIN),
    kind: Schema.Literals(["search", "details"]),
    key: Schema.NonEmptyString,
    savedAt: Schema.Finite,
    data: Schema.Array(Details),
  });
  const PageRecord = Schema.Struct({
    event: Schema.Literal("catalog"),
    version: Schema.Literal(1),
    origin: Schema.Literal(MANGANATO_ORIGIN),
    kind: Schema.Literal("page"),
    key: Schema.NonEmptyString,
    query: Schema.NonEmptyString,
    savedAt: Schema.Finite,
    data: SearchPage,
  });
  const InventoryRecord = Schema.Struct({
    event: Schema.Literal("catalog"),
    // Version 1 discarded updated_at. Refetch those inventories once for date tie-breaks.
    version: Schema.Literal(2),
    origin: Schema.Literal(MANGANATO_ORIGIN),
    kind: Schema.Literal("chapters"),
    key: Schema.NonEmptyString,
    id: Schema.NonEmptyString,
    offset: Schema.Int,
    savedAt: Schema.Finite,
    data: ChapterPage,
  });
  for (const line of options.catalog ?? []) {
    const decoded = Schema.decodeUnknownOption(CatalogRecord)(line);
    if (Option.isSome(decoded)) {
      const entry = decoded.value;
      if (
        entry.kind === "details" &&
        (entry.data.length !== 1 || entry.data[0]!.id !== entry.key)
      ) {
        continue;
      }
      cache.set(`${entry.kind}:${entry.key}`, entry);
    }
    const decodedPage = Schema.decodeUnknownOption(PageRecord)(line);
    if (Option.isSome(decodedPage)) {
      const entry = decodedPage.value;
      const prefix = `/search/story/${encodeURIComponent(entry.query)}?page=`;
      if (entry.key.startsWith(prefix) && /^[1-9]\d*$/.test(entry.key.slice(prefix.length))) {
        pages.set(entry.key, entry);
      }
    }
    const inventory = Schema.decodeUnknownOption(InventoryRecord)(line);
    if (
      Option.isSome(inventory) &&
      inventory.value.key === `${inventory.value.id}:${inventory.value.offset}`
    ) {
      inventories.set(inventory.value.key, inventory.value);
    }
  }
  const fresh = (savedAt: number): boolean => {
    const age = epochMillisNow() - savedAt;
    return age >= 0 && age < 86_400_000;
  };
  const cached = (kind: string, key: string): readonly ManganatoDetails[] | undefined => {
    const entry = cache.get(`${kind}:${key}`);
    if (entry && fresh(entry.savedAt)) {
      return entry.data;
    }
    return undefined;
  };
  const remember = (kind: string, key: string, data: readonly ManganatoDetails[]): void => {
    const savedAt = epochMillisNow();
    cache.set(`${kind}:${key}`, { savedAt, data });
    options.onCache?.({
      event: "catalog",
      version: 1,
      origin: MANGANATO_ORIGIN,
      kind,
      key,
      savedAt,
      data: [...data],
    });
  };
  const read = async <A>(
    path: string,
    parser: string,
    schema: Schema.ConstraintDecoder<A>,
  ): Promise<A> => {
    for (;;) {
      if (requested) {
        await sleepPromise(options.delay);
      }
      requested = true;
      options.onProgress?.(path);
      let wire: JsonValue;
      try {
        wire = await options.view.evaluate<JsonValue>(`(async () => {
      if (location.origin !== ${JSON.stringify(MANGANATO_ORIGIN)}) throw new Error('Open www.manganato.gg in this tab first');
      const signal = AbortSignal.timeout(20000);
      let response, text;
      try {
        response = await fetch(${JSON.stringify(path)}, {credentials:'same-origin', redirect:'error', signal});
        const challenged = response.headers.get('cf-mitigated') === 'challenge';
        if (challenged || response.status === 403 || response.status === 429) {
          return {status:response.status, challenged, data:null};
        }
        text = await response.text();
      } catch (error) {
        if (signal.aborted) return {status:0, challenged:false, timedOut:true, data:null};
        throw error;
      }
      const doc = new DOMParser().parseFromString(text, 'text/html');
      const challenged = doc.title.trim().toLowerCase().startsWith('just a moment') || !!doc.querySelector('#challenge-running, #challenge-form');
      return {status:response.status, challenged, data:response.status === 200 && !challenged ? (() => {${parser}})() : null};
    })()`);
      } catch (error) {
        if (!/\b(?:timeout(?:error)?|timed out)\b/i.test(errorMessage(error))) {
          throw error;
        }
        wire = { status: 0, challenged: false, timedOut: true, data: null };
      }
      const response = await runHost(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Finite,
            challenged: Schema.Boolean,
            timedOut: Schema.optional(Schema.Boolean),
            data: Schema.Unknown,
          }),
        )(wire),
      );
      if (
        response.challenged ||
        response.status === 403 ||
        response.status === 429 ||
        response.timedOut
      ) {
        const error = new ManganatoBlockedError({
          message: `MangaNato ${path}: ${response.timedOut ? "request timed out; inspect regular Chrome for a challenge or connection problem" : response.challenged ? "Cloudflare challenge; solve it in regular Chrome" : `HTTP ${response.status}; inspect Chrome or wait before retrying`}.`,
          ...(response.timedOut && { reason: "timeout" }),
        });
        if (!options.onBlocked) {
          throw error;
        }
        await options.onBlocked(error);
        continue;
      }
      if (response.status !== 200) {
        throw cliError(`MangaNato ${path}: HTTP ${response.status}`);
      }
      return runHost(Schema.decodeUnknownEffect(schema)(response.data));
    }
  };
  const getDetails = async (id: string): Promise<ManganatoDetails> => {
    const saved = cached("details", id);
    if (saved) {
      options.onProgress?.(`Cached details: ${id}`);
      return saved[0]!;
    }
    const result = await read(
      `/manga/${encodeURIComponent(id)}`,
      `
      const authorRow = [...doc.querySelectorAll('.info-wrap > div')].find(e => /Author\\(s\\):/i.test(e.textContent));
      return {id:${JSON.stringify(id)}, title:doc.querySelector('h1')?.textContent?.trim() ?? '',
        aliases:(doc.querySelector('.story-alternative')?.textContent ?? '').replace(/^Alternative\\s*:?/i, '').split(';').map(s => s.trim()).filter(Boolean),
        authors:(authorRow?.textContent ?? '').replace(/Author\\(s\\):/i, '').split(/[,;\\/]/).map(s => s.trim()).filter(Boolean)};
    `,
      Details,
    );
    remember("details", id, [result]);
    return result;
  };
  return {
    details: getDetails,
    coverage: async (id: string): Promise<ManganatoCoverage> => {
      const positions = new Set<number>();
      let unknown = false;
      let latestChapterUpdatedAt = 0;
      let completeDates = true;
      const seen = new Set<string>();
      const inventory = {
        rawRecords: 0,
        duplicateRecords: 0,
        excludedNegativeRecords: 0,
        normalizedRecords: 0,
      };
      let offset = 0;
      let total: number | undefined;
      for (let page = 0; page < options.maxPages; page++) {
        const key = `${id}:${offset}`;
        const stored = inventories.get(key);
        const saved = stored && fresh(stored.savedAt) ? stored : undefined;
        if (saved) {
          options.onProgress?.(`Cached chapters: ${id} offset ${offset}`);
        }
        const result =
          saved?.data ??
          (await read(
            `/api/manga/${encodeURIComponent(id)}/chapters?limit=9000&offset=${offset}`,
            "return JSON.parse(text);",
            ChapterPage,
          ));
        const { chapters: items, pagination } = result.data;
        const nextOffset = offset + items.length;
        if (
          pagination.offset !== offset ||
          pagination.total < 0 ||
          pagination.limit < 1 ||
          items.length > pagination.limit ||
          nextOffset > pagination.total ||
          (total !== undefined && total !== pagination.total) ||
          pagination.has_more !== nextOffset < pagination.total ||
          (pagination.has_more && items.length === 0)
        ) {
          throw cliError(`MangaNato ${id}: incomplete or inconsistent chapter inventory`);
        }
        total = pagination.total;
        const pageNumbers = new Map<string, number | undefined>();
        for (const item of items) {
          if (seen.has(item.chapter_slug)) {
            throw cliError(
              `MangaNato ${id}: repeated chapter IDs across pages at offset ${offset}; incomplete inventory`,
            );
          }
          inventory.rawRecords++;
          const raw = item.chapter_num;
          const parsed = Schema.is(Schema.Finite)(raw)
            ? raw
            : raw !== null && /^-?\d+(?:\.\d+)?$/.test(raw.trim())
              ? Number(raw)
              : undefined;
          const number = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
          // Negative extras may collide with a positive chapter's slug. Keep raw pagination,
          // but never let their order replace or block the positive position used for scoring.
          if (number !== undefined && number < 0) {
            inventory.excludedNegativeRecords++;
            continue;
          }
          // Provider chapter-update time, not report/cache fetch time or manga metadata edits.
          const date = item.updated_at;
          const timestamp =
            date && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(date)
              ? Date.parse(date)
              : NaN;
          if (
            !Number.isFinite(timestamp) ||
            timestamp <= 0 ||
            timestamp > epochMillisNow() ||
            DateTime.formatIso(DateTime.makeUnsafe(timestamp)).slice(0, 19) !== date!.slice(0, 19)
          ) {
            completeDates = false;
          } else {
            latestChapterUpdatedAt = Math.max(latestChapterUpdatedAt, timestamp);
          }
          const normalized = number !== undefined ? normalizeChapterNumber(number) : undefined;
          if (normalized !== number) {
            inventory.normalizedRecords++;
          }
          if (pageNumbers.has(item.chapter_slug)) {
            if (normalized === undefined || pageNumbers.get(item.chapter_slug) !== normalized) {
              throw cliError(
                `MangaNato ${id}: conflicting chapter numbers for ${item.chapter_slug} at offset ${offset}; no link selected`,
              );
            }
            inventory.duplicateRecords++;
            continue;
          }
          pageNumbers.set(item.chapter_slug, normalized);
          if (normalized === undefined) {
            unknown = true;
          } else {
            positions.add(normalized);
          }
        }
        // Include negative records in cross-page overlap detection as well.
        for (const item of items) {
          seen.add(item.chapter_slug);
        }
        if (!saved) {
          const savedAt = epochMillisNow();
          inventories.set(key, { savedAt, data: result });
          options.onCache?.({
            event: "catalog",
            version: 2,
            origin: MANGANATO_ORIGIN,
            kind: "chapters",
            key,
            id,
            offset,
            savedAt,
            data: result,
          });
        }
        if (!pagination.has_more) {
          const numbers = [...positions].sort((a, b) => a - b);
          options.onProgress?.(
            `${id}: ${inventory.rawRecords} raw records; ${inventory.duplicateRecords} duplicates; ${inventory.excludedNegativeRecords} negative records excluded; ${inventory.normalizedRecords} precision tails normalized; ${numbers.length} distinct positions`,
          );
          return {
            unit: unknown ? "unknown" : "chapters",
            count: numbers.length,
            numbers,
            ...(completeDates && latestChapterUpdatedAt > 0 && { latestChapterUpdatedAt }),
            inventory,
          };
        }
        offset = nextOffset;
      }
      throw cliError(`MangaNato ${id}: chapter inventory exceeded --max-pages; no link selected`);
    },
    // Yield each validated page so callers can stop at proven ambiguity, never at a lone match.
    search: async function* (
      query: string,
      maxPages = options.maxPages,
    ): AsyncGenerator<readonly ManganatoDetails[]> {
      // MangaNato returns HTTP 404 for search routes ending in a period, even when escaped.
      // Strip only terminal periods from discovery; identity matching keeps the original title.
      const key = query.toLowerCase().replace(/\s+/g, "_").replace(/\.+$/, "");
      // Older reports stored complete queries rather than individual pages.
      const saved = cached("search", key);
      if (saved) {
        options.onProgress?.(`Cached complete search: ${query}`);
        yield saved;
        return;
      }
      let path = `/search/story/${encodeURIComponent(key)}?page=1`;
      const visited = new Set<string>();
      const fingerprints = new Set<string>();
      const found = new Set<string>();
      for (let page = 1; ; page++) {
        if (page > maxPages) {
          throw new ManganatoPageBudgetError({
            message: `Incomplete MangaNato search for ${query}; page budget ${maxPages} exhausted`,
          });
        }
        if (visited.has(path)) {
          throw cliError(`Incomplete MangaNato search for ${query}; repeated pagination`);
        }
        visited.add(path);
        const stored = pages.get(path);
        const savedPage = stored && fresh(stored.savedAt) ? stored : undefined;
        if (savedPage) {
          options.onProgress?.(`Cached search page: ${path}`);
        }
        const result =
          savedPage?.data ??
          (await read(
            path,
            `
          const items = [...doc.querySelectorAll('div.story_item')].map(e => {
            const a = e.querySelector('.story_name a') ?? e.querySelector('a');
            const url = new URL(a?.getAttribute('href') ?? '', ${JSON.stringify(MANGANATO_ORIGIN)});
            return {id:url.origin === ${JSON.stringify(MANGANATO_ORIGIN)} && /^\\/manga\\/[^/]+\\/?$/.test(url.pathname) ? url.pathname.split('/')[2] : '', title:e.querySelector('.story_name')?.textContent?.trim() ?? ''};
          });
          const next = [...doc.querySelectorAll('.panel_page_number a')].find(a => /^next\\b/i.test(a.textContent.trim()) && a.getAttribute('href'));
          return {title:doc.title, items, next:next?.getAttribute('href') ?? null};
        `,
            SearchPage,
          ));
        if (!/^Search Results for /i.test(result.title) || isChallengeText(result.title)) {
          throw cliError(`Unexpected MangaNato search page for ${query}`);
        }
        const fingerprint = result.items
          .map((item) => item.id)
          .sort()
          .join("|");
        if (
          (result.items.length && fingerprints.has(fingerprint)) ||
          (!result.items.length && result.next)
        ) {
          throw cliError(`Incomplete MangaNato search for ${query}; repeated/empty page`);
        }
        fingerprints.add(fingerprint);
        let nextPath: string | undefined;
        if (result.next) {
          let next: URL;
          let nextQuery: string;
          try {
            next = new URL(result.next, `${MANGANATO_ORIGIN}${path}`);
            const segment = /^\/search\/story\/([^/]+)$/.exec(next.pathname)?.[1];
            nextQuery = segment === undefined ? "" : decodeURIComponent(segment);
          } catch {
            throw cliError(`Invalid MangaNato pagination for ${query}`);
          }
          nextPath = `/search/story/${encodeURIComponent(key)}?page=${page + 1}`;
          // Provider links escape punctuation differently; compare the decoded query exactly once.
          if (
            next.origin !== MANGANATO_ORIGIN ||
            next.username !== "" ||
            next.password !== "" ||
            nextQuery !== key ||
            next.search !== `?page=${page + 1}` ||
            next.href.includes("#")
          ) {
            throw cliError(`Invalid MangaNato pagination for ${query}`);
          }
        }
        if (!savedPage) {
          const savedAt = epochMillisNow();
          pages.set(path, { savedAt, data: result });
          options.onCache?.({
            event: "catalog",
            version: 1,
            origin: MANGANATO_ORIGIN,
            kind: "page",
            key: path,
            query: key,
            savedAt,
            data: result,
          });
        }
        const items = result.items.filter((item) => {
          if (found.has(item.id)) {
            return false;
          }
          found.add(item.id);
          return true;
        });
        yield items.map((item) => ({ ...item, aliases: [], authors: [] }));
        if (!nextPath) {
          return;
        }
        path = nextPath;
      }
    },
  };
};
