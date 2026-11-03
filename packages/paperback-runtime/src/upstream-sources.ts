import type { ContentProvider } from "@manifold/contract";

// Native Paperback source IDs and unmodified manga IDs verified against a device
// PAS5 export. Keep this file free of @paperback/types: the CLI imports it, and
// bundling Paperback code breaks its release notices (cli/scripts/third-party-notices.ts).
export const UPSTREAM_SOURCES = [
  { provider: "mangadex", sourceId: "MangaDex" },
  { provider: "kagane", sourceId: "Kagane" },
  { provider: "manganato", sourceId: "MangaNato" },
  { provider: "xcomic", sourceId: "XCOMIC" },
] as const satisfies readonly { readonly provider: ContentProvider; readonly sourceId: string }[];
