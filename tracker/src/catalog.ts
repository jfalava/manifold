import type { ExtensionInfo } from "@paperback/types";
import info from "./ManifoldTracker/pbconfig.js";

export const catalog = {
  id: "ManifoldTracker",
  info: info as ExtensionInfo,
} as const;
