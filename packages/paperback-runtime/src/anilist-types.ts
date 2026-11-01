/* SPDX-License-Identifier: MIT */
/* Copyright © 2026 Jorge Fernando Álava. */
/* Modified by Manifold on 2026-09-05. See ATTRIBUTIONS.md. */

import { parseListStatus, type ListStatus } from "@manifold/contract";

export type AniListReadingStatus = ListStatus;

export const parseAniListReadingStatus = parseListStatus;

export const ANILIST_SESSION_KEY = "manifold.anilist-session";
export const ANILIST_VIEWER_ID_KEY = "manifold.anilist-viewer-id";
export const ANILIST_STATUS_KEY = "manifold.anilist-status";

/**
 * Worker AniList app used for device login. The CLI app (49218) redirects
 * to localhost and must not be used by the tracker.
 */
export const ANILIST_OAUTH_CLIENT_ID = "49060";
