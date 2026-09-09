export type AniListReadingStatus =
  | "reading"
  | "on_hold"
  | "plan_to_read"
  | "dropped"
  | "re_reading"
  | "completed";

export const parseAniListReadingStatus = (value: string): AniListReadingStatus | undefined => {
  switch (value) {
    case "reading":
    case "on_hold":
    case "plan_to_read":
    case "dropped":
    case "re_reading":
    case "completed":
      return value;
    default:
      return undefined;
  }
};

export const ANILIST_SESSION_KEY = "manifold.anilist-session";
export const ANILIST_VIEWER_ID_KEY = "manifold.anilist-viewer-id";
export const ANILIST_STATUS_KEY = "manifold.anilist-status";

/**
 * Worker AniList app used for device login. The CLI app (49218) redirects
 * to localhost and must not be used by the tracker.
 */
export const ANILIST_OAUTH_CLIENT_ID = "49060";
