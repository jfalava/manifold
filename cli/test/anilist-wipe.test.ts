import { describe, expect, it } from "vitest";
import { selectWipeActivities, type Activity } from "../src/anilist-wipe";

const mangaListActivity = (id: number): Activity => ({
  type: "MANGA_LIST",
  id,
  status: "reading",
  progress: "12",
  mediaTitle: "Some Manga",
});

const textActivity = (id: number, text: string): Activity => ({ type: "TEXT", id, text });

describe("anilist wipe activity selection", () => {
  it("targets typed MANGA_LIST activities by default", () => {
    const activities = [mangaListActivity(1), mangaListActivity(2)];
    expect(selectWipeActivities(activities)).toEqual(activities);
  });

  it("never targets TEXT activities by keyword match, even obvious manga prose", () => {
    const activities = [
      textActivity(1, "Read the latest manga chapter"),
      textActivity(2, "Volume 5 arrived today"),
      textActivity(3, "Picking up the light novel series"),
      textActivity(4, "New manhwa recommendation"),
    ];
    expect(selectWipeActivities(activities)).toEqual([]);
  });

  it("excludes unrelated prose and anime posts by default", () => {
    const activities = [
      textActivity(1, "already watched the anime, great show"),
      textActivity(2, "Reading progress: finished this series!"),
      textActivity(3, "I read the news this morning"),
    ];
    expect(selectWipeActivities(activities)).toEqual([]);
  });

  it("never targets unknown activity types, including anime list activity", () => {
    // SAFETY: test fixture intentionally simulates an out-of-union activity
    // type (ANIME_LIST) to prove selection drops unknown types; the fixture
    // JSON is fully controlled here.
    const animeListActivity = JSON.parse(
      '{"type":"ANIME_LIST","id":1,"status":"watching"}',
    ) as Activity;
    expect(selectWipeActivities([animeListActivity])).toEqual([]);
  });

  it("includes TEXT activities only with the explicit includeTextActivities opt-in", () => {
    const activities = [
      mangaListActivity(1),
      textActivity(2, "already watched the anime, great show"),
    ];
    const selected = selectWipeActivities(activities, { includeTextActivities: true });
    expect(selected).toHaveLength(2);
    expect(selected).toEqual(activities);
  });
});
