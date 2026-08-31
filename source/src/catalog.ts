import type { ExtensionInfo } from "@paperback/types";
import info from "./ManifoldSource/pbconfig.js";

export const catalog = {
  id: "ManifoldSource",
  // SAFETY: value matches ExtensionInfo at this call site
  info: info as ExtensionInfo,
} as const;
