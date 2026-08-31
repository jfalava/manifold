# Paperback Comix source

This package is the device-side Paperback extension for Comix. It is deliberately
separate from `@manifold/comix`, which contains provider-neutral contracts for the
Cloudflare Workers side of the monorepo.

The source calls `comix.to` directly through Paperback's request scheduler. Its
Cloudflare cookies are stored in Paperback's local state manager and are never
sent through `manifold.jfa.dev`; this keeps the Turnstile/session boundary on
the device.

The source also exposes Paperback's native settings form. Use **Open Comix**
there to complete the in-app browser check; the returned cookies are passed to
the same local interceptor used by source requests.

The Comix search and manga endpoints are mapped. Comix's chapter endpoints have
been observed to return a signed/encrypted envelope. The source first accepts a
plain/decrypted response when available, then falls back to Paperback's
`Application.executeInWebView` to let Comix's own page JavaScript resolve the
chapter list or reader images. The browser bridge remains device-local and does
not move signing, cookies, or challenge state into the router Worker.

`@manifold/source` composes this class into the ManifoldSource production
bundle, so the standalone adapter remains reusable without becoming a second
installed source.
