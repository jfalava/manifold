/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex; modifications Copyright © 2026 Jorge Fernando Álava. */
/* Last modified by Manifold on 2026-11-01. See ATTRIBUTIONS.md. */

/** @effect-diagnostics asyncFunction:off */
import { manifoldUserAgent } from "@manifold/json";

import { createAniListClient } from "./anilist-graphql.js";

/** The device's AniList client. Paperback has no global fetch, so requests go through Application. */
export const {
  aniListRequest,
  fetchAniListLibrary,
  fetchAniListMediaListEntryIds,
  saveAniListStatus,
  saveAniListProgress,
  saveAniListFields,
  deleteAniListEntry,
} = createAniListClient({
  post: async ({ url, headers, body }) => {
    const [response, buffer] = await Application.scheduleRequest({
      url,
      method: "POST",
      headers,
      body,
    });

    return {
      status: response.status,
      headers: response.headers ?? {},
      text: Application.arrayBufferToUTF8String(buffer),
    };
  },
  // Application.sleep takes whole seconds.
  sleep: (ms) => Application.sleep(Math.ceil(ms / 1000)),
  userAgent: manifoldUserAgent("paperback-runtime"),
});
