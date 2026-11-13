import { expect, test } from "bun:test";

import {
  BindProviderInput,
  decodeInput,
  DisconnectAuthInput,
  ImportAniListTokenInput,
  LoadMangaDexLibraryInput,
  LoadMangaDexStatsInput,
  RetryOpInput,
  SaveListStateInput,
  SetMangaDexStatusInput,
  UnlinkProviderInput,
} from "../src/lib/registry-inputs";

const MANGADEX_ID = "a1c7c817-4e59-43b7-9365-09675a149a6f";

test("a provider that would change the API path is refused", () => {
  expect(
    decodeInput(UnlinkProviderInput, "unlinkProvider", { entryId: "e1", provider: "mangadex" }),
  ).toEqual({ entryId: "e1", provider: "mangadex" });

  for (const provider of ["../../ops", "mal/extra", "mal?x=1", "mal#x", "MAL", ""]) {
    expect(() =>
      decodeInput(UnlinkProviderInput, "unlinkProvider", { entryId: "e1", provider }),
    ).toThrow("Invalid input for unlinkProvider");

    expect(() =>
      decodeInput(BindProviderInput, "bindProvider", { entryId: "e1", provider, externalId: "1" }),
    ).toThrow("Invalid input for bindProvider");
  }
});

test("a MangaDex id that is not a UUID is refused", () => {
  expect(
    decodeInput(SetMangaDexStatusInput, "setMangaDexStatus", {
      mangaDexId: MANGADEX_ID,
      status: "unset",
    }),
  ).toEqual({ mangaDexId: MANGADEX_ID, status: "unset" });

  for (const mangaDexId of ["../library", `${MANGADEX_ID}/../x`, `${MANGADEX_ID}?x=1`, ""]) {
    expect(() =>
      decodeInput(SetMangaDexStatusInput, "setMangaDexStatus", { mangaDexId, status: "reading" }),
    ).toThrow("Invalid input for setMangaDexStatus");
  }

  expect(() =>
    decodeInput(SetMangaDexStatusInput, "setMangaDexStatus", {
      mangaDexId: MANGADEX_ID,
      status: "finished",
    }),
  ).toThrow("Invalid input for setMangaDexStatus");
});

test("a list-state patch keeps only the declared fields", () => {
  expect(
    decodeInput(SaveListStateInput, "saveListState", {
      entryId: "e1",
      status: "reading",
      score: 8,
      origin: "tracker",
      appliedRemotely: true,
    }),
  ).toEqual({ entryId: "e1", status: "reading", score: 8 });

  expect(() =>
    decodeInput(SaveListStateInput, "saveListState", { entryId: "e1", status: "finished" }),
  ).toThrow("Invalid input for saveListState");

  expect(() =>
    decodeInput(SaveListStateInput, "saveListState", { entryId: "e1", score: "8" }),
  ).toThrow("Invalid input for saveListState");

  expect(() => decodeInput(SaveListStateInput, "saveListState", { status: "reading" })).toThrow(
    "Invalid input for saveListState",
  );
});

test("inputs of the wrong shape are refused before any API call", () => {
  expect(() => decodeInput(RetryOpInput, "retryOp", { opId: "" })).toThrow();
  expect(() => decodeInput(RetryOpInput, "retryOp", { opId: 7 })).toThrow();
  expect(() => decodeInput(RetryOpInput, "retryOp", null)).toThrow();
  expect(() => decodeInput(LoadMangaDexLibraryInput, "library", { status: "all" })).toThrow();
  expect(() => decodeInput(LoadMangaDexStatsInput, "stats", { ids: [MANGADEX_ID, 3] })).toThrow();
  expect(() => decodeInput(ImportAniListTokenInput, "token", { accessToken: 1 })).toThrow();
  expect(() => decodeInput(DisconnectAuthInput, "disconnect", { provider: "kagane" })).toThrow();

  expect(decodeInput(LoadMangaDexLibraryInput, "library", {})).toEqual({});
  expect(decodeInput(DisconnectAuthInput, "disconnect", { provider: "mal" })).toEqual({
    provider: "mal",
  });
});

test("a rejected input is not echoed in the error", () => {
  expect(() =>
    decodeInput(ImportAniListTokenInput, "importAniListToken", {
      accessToken: "secret-token",
      expiresIn: "soon",
    }),
  ).toThrow(/^Invalid input for importAniListToken$/);
});
