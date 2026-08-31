import { describe, expect, it } from "vitest";
import {
  comixBrowseUrl,
  hidOf,
  isChallengeText,
  itemsFromCapture,
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
      pickMatch([item], [
        "Tonari no Uchuubito ga Kowai",
        "My Neighbor Furi-san is Scary",
      ]),
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
    ).toEqual([
      "Tonari no Uchuubito ga Kowai",
      "My Neighbor Furi-san is Scary",
    ]);
  });
});

describe("comix capture payloads", () => {
  it("builds the browse URL the site itself uses", () => {
    expect(comixBrowseUrl("solo leveling", 2)).toBe(
      "https://comix.to/browse?page=2&keyword=solo+leveling",
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
    expect(isChallengeText("<div class=\"cf-chl-widget\"></div>")).toBe(true);
    expect(isChallengeText("Omniscient Reader")).toBe(false);
  });
});
