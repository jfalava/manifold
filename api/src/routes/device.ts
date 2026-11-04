/**
 * Browser side of the CLI device grant (RFC 8628): the /device approval page,
 * the device authorization endpoint, and the GitHub callback for approvals.
 *
 * The page has no script. Approve posts a form that redirects to GitHub; the
 * GitHub callback approves the grant only in the browser that started it.
 */
import { Effect } from "effect";

import {
  formatUserCode,
  normalizeUserCode,
  type DeviceApprovalResult,
  type DeviceGrantStatus,
} from "../manifold-sync/device-grant";
import {
  json,
  publicSiteOrigin,
  resolveRedirectBase,
  tryPromise,
  type RouteContext,
} from "../http";

const BINDING_COOKIE = "manifold_device_binding";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: oklch(1 0 0); --fg: oklch(0.205 0 0); --muted: oklch(0.45 0 0);
    --line: oklch(0.9 0 0); --primary: oklch(0.511 0.262 276.966); --on-primary: oklch(0.985 0 0);
    --danger: oklch(0.577 0.245 27.325);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: oklch(0.15 0 0); --fg: oklch(0.985 0 0); --muted: oklch(0.7 0 0);
      --line: oklch(0.3 0 0); --primary: oklch(0.673 0.182 276.935); --on-primary: oklch(0.15 0 0);
      --danger: oklch(0.704 0.191 22.216);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-block-size: 100svh; padding: clamp(2rem, 12vh, 7rem) 1.5rem;
    display: flex; background: var(--bg); color: var(--fg);
    font: 1.0625rem/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { inline-size: 100%; max-inline-size: 30rem; margin: auto; }
  .context { margin: 0 0 0.375rem; color: var(--muted); font-size: 0.875rem; letter-spacing: 0.04em; }
  h1 { margin: 0 0 1rem; font-size: clamp(1.75rem, 5vw, 2rem); font-weight: 600; line-height: 1.2; letter-spacing: -0.025em; }
  p { margin: 0 0 1rem; }
  .muted { color: var(--muted); font-size: 0.9375rem; }
  .code {
    margin: 1.5rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: 0.75rem;
    font: 600 clamp(1.75rem, 8vw, 2.5rem)/1 ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: 0.12em; text-align: center;
  }
  form { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-block-start: 1.5rem; }
  input {
    flex: 1 1 12rem; padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: 0.5rem;
    background: transparent; color: inherit; font: 600 1.25rem ui-monospace, Menlo, monospace;
    letter-spacing: 0.1em; text-transform: uppercase;
  }
  button {
    flex: 1 1 8rem; padding: 0.75rem 1.25rem; border-radius: 0.5rem; font: inherit; font-weight: 600;
    cursor: pointer; border: 1px solid var(--line); background: transparent; color: inherit;
  }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
  .error { color: var(--danger); }
`;

const page = (title: string, body: string, status = 200): Response =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Manifold</title>
  <style>${STYLE}</style>
</head>
<body><main><p class="context">MANIFOLD CLI</p>${body}</main></body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Not no-referrer: Chrome then sends `Origin: null` on the form post and the
        // same-origin check below rejects it. same-origin still sends nothing to GitHub.
        "referrer-policy": "same-origin",
        "x-content-type-options": "nosniff",
        // form-action covers the 302 to GitHub that follows the Approve post.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' https://github.com; frame-ancestors 'none'",
      },
    },
  );

const entryForm = (value = ""): string => `
  <form method="get" action="/device">
    <input name="code" value="${escapeHtml(value)}" placeholder="XXXX-XXXX" autocomplete="off"
      autocapitalize="characters" spellcheck="false" aria-label="Code from your terminal" required>
    <button class="primary" type="submit">Continue</button>
  </form>`;

const enterCodePage = (): Response =>
  page(
    "Sign in the Manifold CLI",
    `<h1>Sign in the Manifold CLI</h1>
     <p>Enter the code shown in your terminal.</p>${entryForm()}`,
  );

const unknownCodePage = (value: string): Response =>
  page(
    "Code not found",
    `<h1>Code not found</h1>
     <p class="error">This code is invalid or has expired.</p>
     <p class="muted">Check the code in your terminal, or run <code>manifold login manifold</code> again.</p>
     ${entryForm(value)}`,
    404,
  );

const confirmPage = (userCode: string): Response =>
  page(
    "Approve CLI sign-in",
    `<h1>Approve sign-in?</h1>
     <p>A Manifold CLI session is asking to sign in to this Manifold instance.</p>
     <div class="code">${escapeHtml(formatUserCode(userCode))}</div>
     <p class="muted">Approve only if this matches the code in your terminal and you started this login.
       Approving asks you to sign in with GitHub.</p>
     <form method="post" action="/device">
       <input type="hidden" name="code" value="${escapeHtml(userCode)}">
       <button type="submit" name="action" value="deny">Deny</button>
       <button class="primary" type="submit" name="action" value="approve">Approve</button>
     </form>`,
  );

const finishedPage = (status: "approved" | "denied"): Response =>
  status === "approved"
    ? page(
        "CLI signed in",
        `<h1>CLI signed in</h1>
         <p>Return to your terminal; the login finishes there on its own.</p>
         <p class="muted">You can close this tab.</p>`,
      )
    : page(
        "Sign-in denied",
        `<h1>Sign-in denied</h1>
         <p>The CLI was not signed in. Its login stops on its next check.</p>
         <p class="muted">You can close this tab.</p>`,
      );

const statusPage = (status: Exclude<DeviceGrantStatus, "pending">, value: string): Response =>
  status === "unknown" ? unknownCodePage(value) : finishedPage(status);

/** Result page for the GitHub callback of a device approval. */
export const deviceApprovalResultPage = (result: DeviceApprovalResult): Response => {
  switch (result) {
    case "approved":
    case "denied":
      return finishedPage(result);
    case "mismatch":
      return page(
        "GitHub account not authorized",
        `<h1>GitHub account not authorized</h1>
         <p>GitHub sign-in succeeded, but this account cannot use this Manifold instance.</p>
         <p class="muted">Switch to the configured GitHub account, then open the link from your terminal again.
           The CLI keeps waiting until the code expires.</p>`,
        403,
      );
    case "wrong-browser":
      return page(
        "Open the link in one browser",
        `<h1>Finish in the same browser</h1>
         <p class="error">This approval was started in a different browser, so it was not accepted.</p>
         <p class="muted">Open the link from your terminal again and approve it here. The CLI keeps waiting.</p>`,
        400,
      );
    case "expired":
      return page(
        "Approval expired",
        `<h1>Approval expired</h1>
         <p>This approval is no longer valid. Run <code>manifold login manifold</code> again.</p>`,
        400,
      );
    case "error":
      return page(
        "GitHub sign-in failed",
        `<h1>GitHub sign-in failed</h1>
         <p>GitHub did not complete the sign-in. Open the link from your terminal and try again.</p>`,
        502,
      );
  }
};

export const readBindingCookie = (request: Request): string | undefined => {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === BINDING_COOKIE) {
      return rest.join("=") || undefined;
    }
  }

  return undefined;
};

/** Clears the one-shot approval cookie on the callback response. */
export const clearBindingCookie = (response: Response): Response => {
  response.headers.append(
    "set-cookie",
    `${BINDING_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );

  return response;
};

/**
 * Cross-site form posts must not start approvals: a page elsewhere could
 * otherwise submit an attacker's code and ride the owner's GitHub session.
 */
const isSameOriginPost = (request: Request, origin: string): boolean => {
  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite !== null && fetchSite !== "same-origin") {
    return false;
  }

  return request.headers.get("origin") === origin;
};

export const handleDevice = (ctx: RouteContext) =>
  Effect.gen(function* () {
    const { path, request, env, url } = ctx;

    if (path[0] !== "v1" || path[1] !== "oauth" || path.length !== 3) {
      return null;
    }

    const sync = env.MANIFOLD_SYNC.getByName("default");

    if (path[2] === "device_authorization" && request.method === "POST") {
      const form = new URLSearchParams(yield* tryPromise(() => request.text()));

      const grant = yield* tryPromise(() =>
        sync.startDeviceAuthorization(form.get("client_id") ?? ""),
      );

      return grant
        ? json(grant)
        : json({ error: "invalid_client", error_description: "Unknown client" }, 401);
    }

    if (path[2] !== "device") {
      return null;
    }

    if (request.method === "GET") {
      const value = url.searchParams.get("code")?.trim() ?? "";

      if (!value) {
        return enterCodePage();
      }

      const userCode = normalizeUserCode(value);

      if (!userCode) {
        return unknownCodePage(value);
      }

      const status = yield* tryPromise(() => sync.lookupDeviceGrant(userCode));

      return status === "pending" ? confirmPage(userCode) : statusPage(status, value);
    }

    if (request.method !== "POST") {
      return null;
    }

    const origin = publicSiteOrigin(yield* tryPromise(() => resolveRedirectBase(env)));

    if (!isSameOriginPost(request, origin)) {
      return page(
        "Request blocked",
        `<h1>Request blocked</h1><p>Open the link from your terminal and approve on this page.</p>`,
        403,
      );
    }

    const form = new URLSearchParams(yield* tryPromise(() => request.text()));
    const value = form.get("code") ?? "";

    if (form.get("action") === "deny") {
      const status = yield* tryPromise(() => sync.denyDeviceGrant(value));

      return status === "pending" ? confirmPage(value) : statusPage(status, value);
    }

    if (form.get("action") !== "approve") {
      return unknownCodePage(value);
    }

    const start = yield* tryPromise(() => sync.beginDeviceApproval(value));

    if (start.kind === "status") {
      return statusPage(start.status, value);
    }

    return new Response(null, {
      status: 303,
      headers: {
        location: start.authorizationUrl,
        "cache-control": "no-store",
        // Lax is sent on GitHub's top-level redirect back to the callback.
        "set-cookie": `${BINDING_COOKIE}=${start.browserBinding}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  });
