import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";
import pkg from "../../package.json" with { type: "json" };

export default {
  version: pkg.version,
  name: "manifold: source",
  icon: "icon.png",
  description:
    "manifold content source: registry search and verified MangaDex/Comix chapters.",
  contentRating: ContentRating.MATURE,
  developers: [{ name: "manifold" }],
  language: "en",
  badges: [{ label: "beta", textColor: "#ffffff", backgroundColor: "#2563eb" }],
  capabilities: [
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CHAPTER_PROVIDING,
    SourceIntents.DISCOVER_SECTION_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
} satisfies ExtensionInfo;
