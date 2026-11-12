/**
 * The AniList callback imports whatever token is in the URL fragment, and
 * AniList's implicit grant gives nothing to tie that token to this browser. So
 * the Authorize button marks the tab, and the callback imports only in a tab
 * that carries a fresh mark: a link someone else crafted has none.
 */
const STARTED_AT_KEY = "manifold:anilist-authorize-started-at";

const AUTHORIZE_WINDOW_MS = 10 * 60_000;

type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Call right before sending this tab to AniList's authorize page. */
export const beginAniListAuthorize = (storage: TabStorage, now: number): void => {
  storage.setItem(STARTED_AT_KEY, String(now));
};

/** True at most once per authorization, and only inside the window. */
export const consumeAniListAuthorize = (storage: TabStorage, now: number): boolean => {
  const raw = storage.getItem(STARTED_AT_KEY);

  storage.removeItem(STARTED_AT_KEY);

  if (raw === null) {
    return false;
  }

  const elapsed = now - Number(raw);

  return elapsed >= 0 && elapsed <= AUTHORIZE_WINDOW_MS;
};
