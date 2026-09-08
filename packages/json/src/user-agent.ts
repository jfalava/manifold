/**
 * Shared outbound User-Agent for every Manifold HTTP client.
 *
 * Format:
 *   manifold/0.1 (+https://manifold.jfa.dev; manifold/<surface>)
 *
 * `<surface>` names the calling product so upstreams can tell CLI traffic from
 * the API Worker, admin dashboard, tracker extension, etc.
 */

export const MANIFOLD_USER_AGENT_PRODUCT = "manifold/0.1";
export const MANIFOLD_USER_AGENT_HOME = "https://manifold.jfa.dev";

/** Known calling surfaces. Unknown strings are allowed for one-off scripts. */
export type ManifoldUserAgentSurface =
  | "cli"
  | "api"
  | "admin"
  | "tracker"
  | "router"
  | "canonical"
  | "mangadex"
  | "mangaupdates"
  | "paperback-runtime"
  | (string & {});

/** Build the branded User-Agent for one outbound surface. */
export const manifoldUserAgent = (surface: ManifoldUserAgentSurface): string => {
  const note = surface.trim() || "unknown";
  return `${MANIFOLD_USER_AGENT_PRODUCT} (+${MANIFOLD_USER_AGENT_HOME}; manifold/${note})`;
};

/**
 * Merge a Manifold User-Agent into request headers without clobbering an
 * explicit caller-supplied `user-agent`.
 */
export const withManifoldUserAgent = (
  surface: ManifoldUserAgentSurface,
  headers: Record<string, string> = {},
) => {
  if (Object.hasOwn(headers, "user-agent") || Object.hasOwn(headers, "User-Agent")) {
    return headers;
  }
  return { ...headers, "user-agent": manifoldUserAgent(surface) };
};
