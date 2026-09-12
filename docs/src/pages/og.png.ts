/** Docs site browser/Worker host (Astro + client scripts). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
import { generateOpenGraphImage } from "astro-og-canvas";
import { config } from "virtual:nimbus/config";
import { ogCardConfig } from "./og/_og-card-config";

export const prerender = true;

export async function GET() {
  const body = await generateOpenGraphImage({
    title: config.title,
    description: config.description,
    ...ogCardConfig,
  });

  return new Response(body, {
    headers: { "Content-Type": "image/png" },
  });
}
