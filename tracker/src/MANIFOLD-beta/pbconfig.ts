/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";
import pkg from "../../package.json" with { type: "json" };

export default {
  version: `${pkg.version}-beta`,
  name: "MANIFOLD beta",
  icon: "icon.png",
  description: "iOS 27 UI compatibility test channel for MANIFOLD",
  contentRating: ContentRating.MATURE,
  developers: [{ name: "MANIFOLD by JFA" }],
  language: "en",
  badges: [{ label: "beta", textColor: "#ffffff", backgroundColor: "#4f39f6" }],
  capabilities: [
    SourceIntents.PROGRESS_PROVIDING,
    SourceIntents.MANAGED_COLLECTION_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
} satisfies ExtensionInfo;
