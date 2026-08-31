import type { ExtensionInfo } from "@paperback/types";
import info from "./ManifoldTracker/pbconfig.js";

export const catalog = {
  id: "ManifoldTracker",
  // SAFETY: value matches ExtensionInfo at this call site
  info: info as ExtensionInfo,
} as const;
