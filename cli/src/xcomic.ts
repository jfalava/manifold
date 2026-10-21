/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { Data, Schema } from "effect";
import { manifoldUserAgent, type JsonObject } from "@manifold/json";
import { cliError, platformFetch, runHost, sleepPromise } from "@/effect-kit";
import { chapterCoverage, mostCovered, type ChapterCoverage } from "@/chapter-coverage";
import { hasExactKaganeTitle, identityFromUrl, type ProviderIdentity } from "@/kagane";
import { searchTitlesFor } from "@/registry-titles";

export const XCOMIC_ORIGIN = "https://xcomic.me";
export const XCOMIC_ORIGINS = [
  XCOMIC_ORIGIN,
  "https://xcomic.net",
  "https://yona.to",
  "https://comik.to",
];

const Edition = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  subName: Schema.NullOr(Schema.String),
  translatedLanguage: Schema.String,
  chaps_normal: Schema.NullOr(Schema.Finite),
});
const GroupData = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.String,
  type_id: Schema.NullOr(Schema.String),
  is_merged: Schema.Boolean,
  merged_to: Schema.NullOr(Schema.String),
});
const Group = Schema.Struct({
  data: GroupData,
  comicNodes: Schema.Array(Schema.Struct({ data: Edition })),
});
const Detail = Schema.Struct({
  ...Edition.fields,
  altNames: Schema.Array(Schema.String),
  type: Schema.NullOr(Schema.String),
  title_id: Schema.NonEmptyString,
  trackingSites: Schema.NullOr(
    Schema.Struct({
      anilist: Schema.optional(Schema.NullOr(Schema.String)),
      myanimelist: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  title_titleNode: Schema.Struct({ data: GroupData }),
});
export type XComicDetails = Schema.Schema.Type<typeof Detail>;
const Chapters = Schema.Struct({
  paging: Schema.Struct({ pages: Schema.Int }),
  items: Schema.Array(
    Schema.Struct({
      data: Schema.Struct({
        id: Schema.NonEmptyString,
        dbStatus: Schema.String,
        chaNum: Schema.NullOr(Schema.Finite),
      }),
    }),
  ),
});
const EDITION_FIELDS = "id name subName translatedLanguage chaps_normal";
const GROUP_FIELDS = "id title type_id is_merged merged_to";

export class XComicBlockedError extends Data.TaggedError("XComicBlockedError")<{
  readonly message: string;
}> {}

/** Anonymous catalog requests only. No automatic mirror hopping or anti-bot bypass. */
export const createXComicClient = (options: {
  readonly delay: number;
  readonly maxPages?: number;
  readonly origin?: string;
  readonly onProgress?: (message: string) => void;
}) => {
  const origin = options.origin ?? XCOMIC_ORIGIN;
  if (!XCOMIC_ORIGINS.includes(origin)) {
    throw cliError("Unknown XComic origin; use an explicitly supported HTTPS mirror.");
  }
  const maxPages = options.maxPages ?? 200;
  let requested = false;
  const details = new Map<string, XComicDetails>();
  const groups = new Map<string, Schema.Schema.Type<typeof Group>>();
  const inventories = new Map<string, ChapterCoverage>();
  const request = async <A>(
    query: string,
    variables: JsonObject,
    schema: Schema.ConstraintDecoder<A>,
  ): Promise<A> => {
    if (requested) {
      await sleepPromise(options.delay);
    }
    requested = true;
    const response = await platformFetch(`${origin}/query/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-language": "en",
        origin,
        referer: `${origin}/`,
        "user-agent": manifoldUserAgent("cli"),
      },
      body: JSON.stringify({ query, variables }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (
      [401, 403, 429].includes(response.status) ||
      response.headers.get("cf-mitigated") === "challenge" ||
      /<title>Just a moment|cf-chl-|challenge-platform/i.test(text)
    ) {
      throw new XComicBlockedError({
        message: `XComic blocked/rate limited (HTTP ${response.status}); stopping. No browser bypass or mirror failover attempted.`,
      });
    }
    if (response.status !== 200) {
      throw cliError(`XComic HTTP ${response.status}`);
    }
    // GraphQL may return HTTP 200 with partial data and errors; partial results must never win.
    const envelope = await runHost(
      Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            data: Schema.optional(Schema.NullOr(schema)),
            errors: Schema.optional(Schema.Array(Schema.Unknown)),
          }),
        ),
      )(text),
    );
    if (envelope.errors?.length || envelope.data == null) {
      throw cliError("XComic GraphQL errors; refusing partial results");
    }
    return envelope.data;
  };
  const client = {
    details: async (id: string): Promise<XComicDetails> => {
      const cached = details.get(id);
      if (cached) {
        return cached;
      }
      options.onProgress?.(`XComic edition ${id}`);
      const result = await request(
        `query($id:ID!){get_comicNode(id:$id){data{${EDITION_FIELDS} altNames type title_id trackingSites{anilist myanimelist} title_titleNode{data{${GROUP_FIELDS}}}}}}`,
        { id },
        Schema.Struct({ get_comicNode: Schema.Struct({ data: Detail }) }),
      );
      if (result.get_comicNode.data.id !== id) {
        throw cliError(`XComic ${id}: inconsistent edition ID`);
      }
      details.set(id, result.get_comicNode.data);
      return result.get_comicNode.data;
    },
    group: async (id: string) => {
      const cached = groups.get(id);
      if (cached) {
        return cached;
      }
      const result = await request(
        `query($id:ID!){get_title_titleNode(id:$id){data{${GROUP_FIELDS}} comicNodes{data{${EDITION_FIELDS}}}}}`,
        { id },
        Schema.Struct({ get_title_titleNode: Group }),
      );
      if (result.get_title_titleNode.data.id !== id) {
        throw cliError(`XComic ${id}: inconsistent title group ID`);
      }
      groups.set(id, result.get_title_titleNode);
      return result.get_title_titleNode;
    },
    search: async (word: string, language: string): Promise<readonly string[]> => {
      const ids = new Set<string>();
      const fingerprints = new Set<string>();
      let page = 1;
      for (let iteration = 0; iteration < maxPages; iteration++) {
        options.onProgress?.(`Search "${word}" page ${page}`);
        const select = {
          where: "browse",
          page,
          size: 48,
          sortby: "field_score",
          word,
          incOLangs: [],
          incTLangs: [language],
          incGenres: [],
          excGenres: [],
          incGenresMode: "and",
          excGenresMode: "or",
          incTypes: ["cartoon", "imageset", "manga", "manhua", "manhwa", "oel", "other", "western"],
          incDemographics: [],
          incContentRatings: ["safe", "suggestive", "erotica", "pornographic"],
          releaseYearMin: null,
          releaseYearMax: null,
          origStatus: null,
          chapCount: null,
          ignoreGlobalULangs: false,
          ignoreGlobalGenres: false,
          ignoreGlobalBlocks: false,
        };
        const result = await request(
          "query($select:Title_Browse_Select){get_title_browse_items(select:$select){data{id name:title altNames:alt_titles} comicNodes{data{id name}}}}",
          { select },
          Schema.Struct({
            get_title_browse_items: Schema.Array(
              Schema.Struct({
                data: Schema.Struct({
                  id: Schema.NonEmptyString,
                  name: Schema.String,
                  altNames: Schema.NullOr(Schema.Array(Schema.String)),
                }),
                comicNodes: Schema.Array(
                  Schema.Struct({
                    data: Schema.Struct({ id: Schema.NonEmptyString, name: Schema.String }),
                  }),
                ),
              }),
            ),
          }),
        );
        // XComic rejects multiple root fields; the pager must be a separate request.
        const pager = await request(
          "query($select:Title_Browse_Select){get_title_browse_pager(select:$select){next}}",
          { select },
          Schema.Struct({ get_title_browse_pager: Schema.Struct({ next: Schema.Int }) }),
        );
        const fingerprint = JSON.stringify(
          result.get_title_browse_items.map((item) => item.data.id),
        );
        if (fingerprints.has(fingerprint) && result.get_title_browse_items.length) {
          throw cliError("XComic search pagination did not advance");
        }
        fingerprints.add(fingerprint);
        for (const item of result.get_title_browse_items) {
          if (
            hasExactKaganeTitle(
              [word],
              [
                item.data.name,
                ...(item.data.altNames ?? []),
                ...item.comicNodes.map((node) => node.data.name),
              ],
            )
          ) {
            ids.add(item.data.id);
          }
        }
        const next = pager.get_title_browse_pager.next;
        if (next === 0) {
          return [...ids];
        }
        if (next <= page) {
          throw cliError("XComic invalid search pager; refusing incomplete results");
        }
        page = next;
      }
      throw cliError(`XComic search exceeded ${maxPages} pages; no link selected`);
    },
    coverage: async (id: string): Promise<ChapterCoverage> => {
      const cached = inventories.get(id);
      if (cached) {
        return cached;
      }
      const numbers: { chapter: number | null }[] = [];
      const seen = new Set<string>();
      let pages: number | undefined;
      for (let page = 1; page <= (pages ?? 1); page++) {
        options.onProgress?.(`XComic chapters ${id} page ${page}/${pages ?? "?"}`);
        const result = (
          await request(
            "query($select:Select_Comic_ChapterList_UniqList){get_comic_chapterList_uniqList(select:$select){paging{pages} items{data{id dbStatus chaNum}}}}",
            { select: { comic_id: id, page, size: 1000, sortby: "chapter_desc" } },
            Schema.Struct({ get_comic_chapterList_uniqList: Chapters }),
          )
        ).get_comic_chapterList_uniqList;
        if (
          result.paging.pages < 0 ||
          result.paging.pages > maxPages ||
          (pages !== undefined && pages !== result.paging.pages)
        ) {
          throw cliError(`XComic ${id}: inconsistent or excessive chapter page count`);
        }
        pages = result.paging.pages;
        let added = 0;
        for (const { data } of result.items) {
          if (seen.has(data.id)) {
            throw cliError(`XComic ${id}: duplicate chapter ID/incomplete pagination`);
          }
          seen.add(data.id);
          added++;
          if (data.dbStatus === "normal") {
            numbers.push({ chapter: data.chaNum });
          }
        }
        if ((pages > 0 && added === 0) || (pages === 0 && result.items.length)) {
          throw cliError(`XComic ${id}: incomplete chapter inventory`);
        }
      }
      const coverage = chapterCoverage(numbers);
      inventories.set(id, coverage);
      return coverage;
    },
  };
  return client;
};

export type XComicCandidate = {
  readonly id: string;
  readonly title: string;
  readonly groupId: string;
  readonly source: string;
  readonly advertisedChapters: number | null;
  readonly identities: readonly ProviderIdentity[];
  readonly matchedIds: readonly string[];
  readonly reasons: readonly string[];
  readonly coverage?: ChapterCoverage;
};

export const verifyXComicCandidate = (
  details: XComicDetails,
  row: { readonly providers: readonly ProviderIdentity[] },
  titles: readonly string[],
  language: string,
  groupId: string,
): XComicCandidate => {
  const reasons: string[] = [];
  const identities: ProviderIdentity[] = [];
  const matchedIds: string[] = [];
  for (const [key, provider, host] of [
    ["anilist", "anilist", "anilist.co"],
    ["myanimelist", "mal", "myanimelist.net"],
  ] as const) {
    const value = details.trackingSites?.[key]?.trim();
    const identity =
      value &&
      (/^[1-9]\d*$/.test(value) ? { provider, externalId: value } : identityFromUrl(value));
    if (value && (!identity || identity.provider !== provider)) {
      reasons.push(`invalid ${host} tracker`);
    }
    if (identity && identity.provider === provider) {
      identities.push(identity);
      const expected = row.providers.find((link) => link.provider === provider)?.externalId;
      if (expected && expected !== identity.externalId) {
        reasons.push(`contradictory ${provider} ID`);
      }
      if (expected === identity.externalId) {
        matchedIds.push(provider);
      }
    }
  }
  if (!matchedIds.length) {
    reasons.push("no corroborating canonical tracker ID; title-only review required");
  }
  if (!hasExactKaganeTitle(titles, [details.name, ...details.altNames])) {
    reasons.push("detail title mismatch");
  }
  if (details.translatedLanguage !== language) {
    reasons.push(`language=${details.translatedLanguage}`);
  }
  // Legacy editions often have null type; the extension inherits the title's type_id.
  const format = details.type ?? details.title_titleNode.data.type_id;
  if (!["manga", "manhwa", "manhua", "oel", "western"].includes(format ?? "")) {
    reasons.push(`unsupported format=${format ?? "missing"}`);
  }
  if (
    details.type &&
    details.title_titleNode.data.type_id &&
    details.type !== details.title_titleNode.data.type_id
  ) {
    reasons.push("edition/title format contradiction");
  }
  if (details.title_id !== groupId || details.title_titleNode.data.id !== groupId) {
    reasons.push("inconsistent title group");
  }
  if (details.title_titleNode.data.is_merged || details.title_titleNode.data.merged_to) {
    reasons.push("merged title group requires review");
  }
  if (
    /(?:one[ -]?shot|pilot|doujin|novel|color(?:ed|ized)?|deluxe|omnibus)/i.test(
      `${details.name} ${details.subName ?? ""}`,
    )
  ) {
    reasons.push("edition/format marker requires review");
  }
  return {
    id: details.id,
    title: details.name,
    groupId,
    source: details.subName?.trim() || "Origin unknown",
    advertisedChapters: details.chaps_normal,
    identities,
    matchedIds,
    reasons,
  };
};

export const selectXComicCandidate = (
  candidates: readonly XComicCandidate[],
): XComicCandidate | undefined => {
  const compatible = candidates.filter(
    (candidate) =>
      candidate.reasons.length === 0 &&
      !(candidate.coverage?.unit === "chapters" && candidate.coverage.count === 0),
  );
  if (
    !compatible.length ||
    compatible.some(
      (candidate) => candidate.coverage?.unit !== "chapters" || candidate.coverage.count === 0,
    )
  ) {
    return undefined;
  }
  for (const provider of ["anilist", "mal"]) {
    if (
      new Set(
        compatible.flatMap((candidate) =>
          candidate.identities
            .filter((identity) => identity.provider === provider)
            .map((identity) => identity.externalId),
        ),
      ).size > 1
    ) {
      return undefined;
    }
  }
  const largest = mostCovered(compatible);
  return largest.length === 1 ? largest[0] : undefined;
};

/** Search bounded aliases, expand discovered groups, and verify editions against every known title. */
export const findXComicCandidates = async (
  client: ReturnType<typeof createXComicClient>,
  row: { readonly providers: readonly ProviderIdentity[] },
  titles: readonly string[],
  language: string,
  currentId?: string,
): Promise<readonly XComicCandidate[]> => {
  const groupIds = new Set<string>();
  for (const title of searchTitlesFor(titles)) {
    for (const id of await client.search(title, language)) {
      groupIds.add(id);
    }
  }
  if (currentId) {
    groupIds.add((await client.details(currentId)).title_id);
  }
  const candidates = new Map<string, XComicCandidate>();
  for (const groupId of groupIds) {
    const group = await client.group(groupId);
    for (const { data: edition } of group.comicNodes) {
      if (edition.translatedLanguage !== language && edition.id !== currentId) {
        continue;
      }
      const details = await client.details(edition.id);
      const verified = verifyXComicCandidate(details, row, titles, language, groupId);
      const reasons = [...verified.reasons];
      if (group.data.is_merged || group.data.merged_to) {
        reasons.push("merged discovery group requires review");
      }
      candidates.set(edition.id, {
        ...verified,
        reasons,
        ...(reasons.length === 0 && { coverage: await client.coverage(edition.id) }),
      });
    }
  }
  if (currentId && !candidates.has(currentId)) {
    throw cliError(`XComic ${currentId}: existing edition missing from its title group`);
  }
  return [...candidates.values()];
};
