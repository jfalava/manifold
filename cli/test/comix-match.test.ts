/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalConsoleInEffect:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalFetchInEffect:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalDateInEffect:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalTimersInEffect:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics processEnvInEffect:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics schemaNumber:off */
/** @effect-diagnostics preferSchemaOverJson:off */
/** @effect-diagnostics globalErrorInEffectCatch:off */
/** @effect-diagnostics globalErrorInEffectFailure:off */
/** @effect-diagnostics runEffectInsideEffect:off */
import { describe, expect, it } from "vitest";
import {
  addComixSearchItems,
  comixItemFromGoogleLink,
  comixBrowseUrl,
  googleComixSearchUrl,
  googleGotoLinks,
  hidOf,
  isChallengeText,
  isGoogleResultsUrl,
  itemsFromCapture,
  itemsFromGoogleLinks,
  pickMatch,
  uniqueTitles,
} from "../src/comix-match";

describe("comix title matching", () => {
  it("returns an exact title hit immediately", () => {
    const items = [
      { hid: "other", title: "Solo Leveling" },
      { hid: "hit", title: "Omniscient Reader" },
    ];
    expect(pickMatch(items, "Omniscient Reader")).toEqual(items[1]);
  });

  it("matches alt titles and hash_id", () => {
    const item = { hash_id: "abc", title: "Primary", altTitles: ["The Villainess Lives Twice"] };
    expect(pickMatch([item], "the villainess lives twice")).toEqual(item);
    expect(hidOf(item)).toBe("abc");
  });

  it("fuzzy-matches stemmed tokens above the 0.65 threshold", () => {
    const item = { hid: "stem", title: "The Villainess Reverse" };
    expect(pickMatch([item], "The Villains Reverse")).toEqual(item);
  });

  it("rejects unrelated titles", () => {
    expect(pickMatch([{ hid: "x", title: "One Piece" }], "Naruto")).toBeUndefined();
    expect(hidOf({ title: "No id" })).toBeUndefined();
  });

  it("matches the English Comix title against a romaji registry alias list", () => {
    const item = {
      hid: "r65x8",
      slug: "tonari-no-furi-san-ga-tonikaku-kowai",
      title: "My Neighbor Furi-san is Scary",
      altTitles: ["Tonari no Furi-san ga Tonikaku Kowai"],
    };
    expect(
      pickMatch([item], ["Tonari no Uchuubito ga Kowai", "My Neighbor Furi-san is Scary"]),
    ).toEqual(item);
  });

  it("dedupes search terms by normalized spelling", () => {
    expect(
      uniqueTitles([
        "Tonari no Uchuubito ga Kowai",
        "tonari no uchuubito ga kowai",
        "My Neighbor Furi-san is Scary",
        "",
      ]),
    ).toEqual(["Tonari no Uchuubito ga Kowai", "My Neighbor Furi-san is Scary"]);
  });
});

describe("comix capture payloads", () => {
  it("builds a relevance-sorted browse URL that includes every content rating", () => {
    expect(comixBrowseUrl("Monesan no Majime Sugiru Tsukiaikata")).toBe(
      "https://comix.to/browse?q=Monesan%20no%20Majime%20Sugiru%20Tsukiaikata&sort=relevance%3Adesc&content_rating=safe%2Csuggestive%2Cerotica%2Cpornographic",
    );
  });

  it("builds the site-restricted Google fallback URL", () => {
    expect(googleComixSearchUrl("Genkaku Shoujo ga Tsukimatou")).toBe(
      "https://www.google.com/search?q=Genkaku%20Shoujo%20ga%20Tsukimatou%20site%3Acomix.to&udm=14&num=20&hl=en",
    );
  });

  it("collects Google's opaque /goto redirect anchors", () => {
    expect(
      googleGotoLinks([
        { href: "/goto?url=CAESmwEB", title: " Makenshi no Maken " },
        { href: "https://www.google.com/goto?url=CAESmwEB", title: "dup of the first" },
        { href: "https://www.google.com/goto?url=OTHER", title: "Second result" },
        { href: "https://comix.to/title/1y7gl", title: "direct link, not a goto" },
        { href: "https://example.com/goto?url=x", title: "not google" },
      ]),
    ).toEqual([
      { href: "https://www.google.com/goto?url=CAESmwEB", title: "Makenshi no Maken" },
      { href: "https://www.google.com/goto?url=OTHER", title: "Second result" },
    ]);
  });

  it("recognizes Google results URLs and rejects the previous page's URL", () => {
    expect(isGoogleResultsUrl("https://www.google.com/search?q=x&udm=14")).toBe(true);
    expect(isGoogleResultsUrl("https://www.google.es/search?q=x")).toBe(true);
    expect(isGoogleResultsUrl("https://comix.to/browse?q=x")).toBe(false);
    expect(isGoogleResultsUrl("https://www.google.com/sorry/index")).toBe(false);
    expect(isGoogleResultsUrl("about:blank")).toBe(false);
  });

  it("extracts the hid and slug from direct and Google-wrapped title links", () => {
    const expected = {
      hid: "3el2",
      slug: "genkaku-shoujo-ga-tsukimatou-hanashi",
      title: "Genkaku Shoujo ga Tsukimatou Hanashi",
    };
    expect(
      comixItemFromGoogleLink(
        "https://comix.to/title/3el2-genkaku-shoujo-ga-tsukimatou-hanashi",
        expected.title,
      ),
    ).toEqual(expected);
    expect(
      comixItemFromGoogleLink(
        "/url?q=https%3A%2F%2Fcomix.to%2Ftitle%2F3el2-genkaku-shoujo-ga-tsukimatou-hanashi",
        expected.title,
      ),
    ).toEqual(expected);
    expect(
      comixItemFromGoogleLink(
        "https://comix.to/title/1y7gl",
        "Monesan no Majime Sugiru Tsukiaikata",
      ),
    ).toEqual({
      hid: "1y7gl",
      title: "Monesan no Majime Sugiru Tsukiaikata",
    });
  });

  it("keeps only unique Comix title links that include a hid", () => {
    expect(
      itemsFromGoogleLinks([
        {
          href: "https://comix.to/title/3el2-genkaku-shoujo-ga-tsukimatou-hanashi",
          title: "Comix",
        },
        {
          href: "https://comix.to/title/3el2-genkaku-shoujo-ga-tsukimatou-hanashi/2034769-chapter-5",
          title: "Genkaku Shoujo ga Tsukimatou Hanashi",
        },
        { href: "https://comix.to/browse?q=genkaku", title: "Browse" },
        { href: "https://example.com/title/not-comix", title: "Wrong site" },
      ]),
    ).toEqual([
      {
        hid: "3el2",
        slug: "genkaku-shoujo-ga-tsukimatou-hanashi",
        title: "Comix",
        altTitles: ["Comix", "Genkaku Shoujo ga Tsukimatou Hanashi"],
      },
    ]);
    expect(
      pickMatch(
        itemsFromGoogleLinks([
          {
            href: "https://comix.to/title/y9j2n-makenshi-no-maken-niyoru-maken-no-tame-no-harem-life/7529993-chapter-1",
            title: "Comix",
          },
          {
            href: "https://comix.to/title/y9j2n-makenshi-no-maken-niyoru-maken-no-tame-no-harem-life/7529993-chapter-1",
            title: "Makenshi no Maken Niyoru Maken no Tame no Harem Life",
          },
        ]),
        "Makenshi no Maken Niyoru Maken no Tame no Harem Life",
      )?.hid,
    ).toBe("y9j2n");
  });

  it("keeps Google title data when browse and Google return the same hid", () => {
    const items = [{ hid: "y9j2n" }];
    addComixSearchItems(items, [
      {
        hid: "y9j2n",
        slug: "makenshi-no-maken-niyoru-maken-no-tame-no-harem-life",
        title: "Makenshi no Maken Niyoru Maken no Tame no Harem Life",
      },
    ]);

    expect(items).toEqual([
      {
        hid: "y9j2n",
        slug: "makenshi-no-maken-niyoru-maken-no-tame-no-harem-life",
        title: "Makenshi no Maken Niyoru Maken no Tame no Harem Life",
        altTitles: ["Makenshi no Maken Niyoru Maken no Tame no Harem Life"],
      },
    ]);
    expect(pickMatch(items, "Makenshi no Maken Niyoru Maken no Tame no Harem Life")?.hid).toBe(
      "y9j2n",
    );
  });

  it("unwraps paperback-style { r } envelopes and empty lists as misses", () => {
    expect(itemsFromCapture({ r: { result: { items: [{ hid: "a", title: "A" }] } } })).toEqual([
      { hid: "a", title: "A" },
    ]);
    expect(itemsFromCapture({ r: { result: { items: [] } } })).toEqual([]);
    expect(itemsFromCapture({ r: null })).toBeUndefined();
  });

  it("parses a JSON string payload and ignores encrypted bodies", () => {
    expect(itemsFromCapture('{"result":{"items":[{"hid":"z"}]}}')).toEqual([{ hid: "z" }]);
    expect(itemsFromCapture('{"e":"ciphertext"}')).toBeUndefined();
  });

  it("detects Cloudflare challenge pages", () => {
    expect(isChallengeText("Just a moment...")).toBe(true);
    expect(isChallengeText('<div class="cf-chl-widget"></div>')).toBe(true);
    expect(isChallengeText("Omniscient Reader")).toBe(false);
  });
});
