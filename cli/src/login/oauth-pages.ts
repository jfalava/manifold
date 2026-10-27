import plexSans from "./fonts/ibm-plex-sans-latin-wght-normal.json" with { type: "json" };

export type CallbackPageState =
  | "received"
  | "declined"
  | "state-mismatch"
  | "missing-code"
  | "provider-error";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Standalone callback document with an embedded font; no scripts or credentials. */
export const renderCallbackPage = (state: CallbackPageState, providerLabel: string): string => {
  const provider = escapeHtml(providerLabel);
  const pages = {
    received: {
      title: "Authorization received",
      detail: "Return to your terminal to check whether sign-in completed.",
      terminal: true,
    },
    declined: {
      title: "Authorization declined",
      detail:
        "No authorization code was received. Return to your terminal and start login again if you want to continue.",
      terminal: true,
    },
    "state-mismatch": {
      title: "This callback was not accepted",
      detail:
        "It does not match the login attempt waiting in your terminal. Return to the browser tab where you started authorization, or cancel login in your terminal and try again.",
      terminal: false,
    },
    "missing-code": {
      title: "No authorization code received",
      detail:
        "This callback is incomplete. Return to the authorization tab and finish signing in. Your terminal is still waiting.",
      terminal: false,
    },
    "provider-error": {
      title: `${provider} could not authorize`,
      detail: "Authorization did not complete. Return to your terminal and start login again.",
      terminal: true,
    },
  };
  const page = pages[state];
  const symbol =
    state === "received"
      ? '<path d="m7 12 3 3 7-7"/>'
      : state === "declined"
        ? '<path d="m8 8 8 8m0-8-8 8"/>'
        : '<circle cx="12" cy="12" r="10"/><path d="M12 7v6m0 4h.01"/>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${page.title} · ${provider} · Manifold CLI</title>
  <style>
    /* ${plexSans.license} */
    @font-face {
      font-family: "IBM Plex Sans";
      font-style: normal;
      font-weight: 100 700;
      font-display: swap;
      src: url("data:font/woff2;base64,${plexSans.woff2}") format("woff2");
    }
    :root {
      color-scheme: light;
      --nb-background: oklch(1 0 0);
      --nb-foreground: oklch(0.205 0 0);
      --nb-muted-foreground: oklch(0.45 0 0);
      --nb-primary: oklch(0.511 0.262 276.966);
      --nb-primary-foreground: oklch(0.985 0 0);
      --nb-warning: oklch(0.48 0.15 65);
      --nb-danger: oklch(0.577 0.245 27.325);
      --nb-font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system,
        BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --nb-background: oklch(0.15 0 0);
        --nb-foreground: oklch(0.985 0 0);
        --nb-muted-foreground: oklch(0.7 0 0);
        --nb-primary: oklch(0.673 0.182 276.935);
        --nb-primary-foreground: oklch(0.15 0 0);
        --nb-warning: oklch(0.78 0.11 80);
        --nb-danger: oklch(0.704 0.191 22.216);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-block-size: 100svh;
      padding: clamp(2rem, 12vh, 7rem) 1.5rem;
      display: flex;
      flex-direction: column;
      background: var(--nb-background);
      color: var(--nb-foreground);
      font-family: var(--nb-font-sans);
      font-size: 1.0625rem;
      line-height: 1.6;
    }
    main { inline-size: 100%; max-inline-size: 30rem; margin: auto; }
    .status {
      display: block;
      inline-size: 3rem;
      block-size: 3rem;
      margin-block-end: 2rem;
      color: var(--nb-warning);
    }
    .received, .declined { border-radius: 50%; padding: 0.55rem; }
    .received { background: var(--nb-primary); color: var(--nb-primary-foreground); }
    .declined { background: var(--nb-muted-foreground); color: var(--nb-background); }
    .provider-error { color: var(--nb-danger); }
    .context { margin: 0 0 0.375rem; color: var(--nb-muted-foreground); font-size: 0.875rem; }
    h1 {
      margin: 0 0 1rem;
      font-size: clamp(1.75rem, 5vw, 2rem);
      font-weight: 600;
      line-height: 1.2;
      letter-spacing: -0.025em;
      text-wrap: balance;
    }
    p { margin: 0; overflow-wrap: anywhere; }
    .closing { margin-block-start: 1.5rem; color: var(--nb-muted-foreground); font-size: 0.9375rem; }
    ::selection { background: var(--nb-primary); color: var(--nb-primary-foreground); }
  </style>
</head>
<body>
  <main>
    <svg class="status ${state}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbol}</svg>
    <p class="context">MANIFOLD CLI / ${provider}</p>
    <h1>${page.title}</h1>
    <p>${page.detail}</p>
    ${page.terminal ? '<p class="closing">You can close this tab.</p>' : ""}
  </main>
</body>
</html>`;
};
