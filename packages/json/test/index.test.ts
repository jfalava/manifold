import { describe, expect, it } from "vitest";

import {
  arrayField,
  errorMessage,
  isFiniteNumber,
  isJsonObject,
  isJsonValue,
  isString,
  numberField,
  objectField,
  requestHref,
  requestInitText,
  stringField,
} from "../src/index";

describe("json boundary parsers", () => {
  it("accepts plain objects and rejects null and arrays", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([1])).toBe(false);
  });

  it("reads trimmed string and finite number fields", () => {
    const record = { title: "  One Piece  ", year: 1997, empty: "  ", count: "12" };
    expect(stringField(record, "title")).toBe("One Piece");
    expect(stringField(record, "empty")).toBeUndefined();
    expect(numberField(record, "year")).toBe(1997);
    expect(numberField(record, "count")).toBe(12);
    expect(objectField(record, "title")).toBeUndefined();
    expect(arrayField({ tags: ["a"] }, "tags")).toEqual(["a"]);
  });

  it("narrows JSON values and primitive guards", () => {
    expect(isJsonValue({ nested: [true, null] })).toBe(true);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isString("x")).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
  });

  it("formats request hrefs and init text without String(object)", () => {
    expect(requestHref("https://example.test/a")).toBe("https://example.test/a");
    expect(requestHref(new URL("https://example.test/b"))).toBe("https://example.test/b");
    // Duck-typed Request-like (no global Request required)
    // SAFETY: fixture only needs a url string field; not a full Request instance.
    expect(requestHref({ url: "https://example.test/c" } as RequestInfo)).toBe(
      "https://example.test/c",
    );
    expect(requestInitText({ body: "{\"ok\":true}" })).toBe("{\"ok\":true}");
    expect(requestInitText({ body: new URLSearchParams("a=1") })).toBeUndefined();
  });

  it("reads error cause as a named unknown parameter", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ code: 7 })).toBe("{\"code\":7}");
  });
});
