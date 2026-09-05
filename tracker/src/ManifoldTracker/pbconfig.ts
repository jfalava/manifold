import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";
import pkg from "../../package.json" with { type: "json" };

export default {
  version: pkg.version,
  name: "manifold: tracker",
  icon: "icon.png",
  description:
    "manifold tracker: AniList list status, managed collections, and read progress.",
  contentRating: ContentRating.MATURE,
  developers: [{ name: "manifold" }],
  language: "en",
  badges: [{ label: "beta", textColor: "#ffffff", backgroundColor: "#2563eb" }],
  capabilities: [
    SourceIntents.PROGRESS_PROVIDING,
    SourceIntents.MANAGED_COLLECTION_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  ],
} satisfies ExtensionInfo;
