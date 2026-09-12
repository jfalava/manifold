/** Docs site browser/Worker host (Astro + client scripts). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
// Full-corpus markdown for AI agents — every published page in one
// document. Scope and collation live in the framework helper; reshape or
// delete this route to change the site's corpus policy.
import { renderLlmsFullMarkdown } from "@cloudflare/nimbus-docs";

export const prerender = true;

export async function GET() {
  return new Response(
    await renderLlmsFullMarkdown({ base: import.meta.env.BASE_URL }),
    {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}
