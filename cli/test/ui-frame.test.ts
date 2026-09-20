import { describe, expect, it } from "vitest";

import { wrapFrameText } from "../src/ui";

describe("wrapFrameText", () => {
  it("returns a single empty line for empty input", () => {
    expect(wrapFrameText("", 40)).toEqual([""]);
  });

  it("splits long URLs so each chunk fits the rail content width", () => {
    const url =
      "https://anilist.co/api/v2/oauth/authorize?client_id=49218&redirect_uri=http%3A%2F%2F127.0.0.1%3A8767%2Fcallback&response_type=code&state=7b536466-4338-4cb7-9c72-83edb45d420c";
    const chunks = wrapFrameText(url, 40);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks.join("")).toBe(url);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
