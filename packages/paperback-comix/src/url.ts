/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex; modifications Copyright © 2026 Jorge Fernando Álava. */
/* Modified by Manifold on 2026-09-05. See ATTRIBUTIONS.md. */

/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics newPromise:off */
export const COMIX_ORIGIN = "https://comix.to";

export const resolveComixUrl = (value: string): string => {
  const trimmed = value.trim();
  const absolute = /^(?:https?:)?\/\/([^/?#]+)/i.exec(trimmed);
  if (absolute) {
    const host = absolute[1]!
      .slice(absolute[1]!.lastIndexOf("@") + 1)
      .split(":", 1)[0]!
      .toLowerCase();
    if (host !== "comix.to" && !host.endsWith(".comix.to")) {
      throw new Error("Comix URL points to an untrusted host");
    }
    return trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  }
  return `${COMIX_ORIGIN}/${trimmed.replace(/^\/+/, "")}`;
};

export const comixSearchUrl = (query: string, page: number): string =>
  `${COMIX_ORIGIN}/api/v1/manga?keyword=${encodeURIComponent(query)}&page=${page}`;
