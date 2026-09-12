/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics schemaSync:off */
/** @effect-diagnostics effectSucceedWithVoid:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics nodeBuiltinImport:off */
/** @effect-diagnostics processEnv:off */
/** @effect-diagnostics cryptoRandomUUID:off */
/** @effect-diagnostics preferSchemaOverJson:off */
import { describe, expect, it } from "vitest";
import { isString, type JsonObject } from "@manifold/json";

import { groupOutboxForDrain } from "../src/outbox-drain";

const row = (id: number, payload: string | JsonObject) => ({
  id,
  payload: isString(payload) ? payload : JSON.stringify(payload),
  attempts: 0,
});

const readPayload = (entryId: string, chapterId: string) => ({
  entryId,
  eventId: `evt-${entryId}-${chapterId}`,
  chapterKey: `mangadex:${chapterId}`,
  provider: "mangadex",
  sourceChapterId: chapterId,
  readAt: 0,
});

describe("groupOutboxForDrain", () => {
  it("groups pending events per manga and dedupes repeated chapters", () => {
    const { groups, invalid } = groupOutboxForDrain([
      row(1, readPayload("anilist:1", "ch-a")),
      row(2, readPayload("anilist:1", "ch-b")),
      row(3, readPayload("anilist:1", "ch-a")),
      row(4, readPayload("anilist:2", "ch-c")),
    ]);

    expect(invalid).toEqual([]);
    expect(groups).toHaveLength(2);

    const first = groups.find((group) => group.entryId === "anilist:1");
    expect(first?.chapters).toEqual(["ch-a", "ch-b"]);
    expect(first?.rows.map((r) => r.id)).toEqual([1, 2, 3]);

    const second = groups.find((group) => group.entryId === "anilist:2");
    expect(second?.chapters).toEqual(["ch-c"]);
  });

  it("routes undecodable payloads to invalid without dropping the rest", () => {
    const { groups, invalid } = groupOutboxForDrain([
      row(1, "{not json"),
      row(2, readPayload("anilist:9", "ch-x")),
      row(3, { provider: "mangadex" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.entryId).toBe("anilist:9");
    expect(invalid.map((r) => r.id)).toEqual([1, 3]);
  });
});
