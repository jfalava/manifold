/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalDate:off */
import type { ExtensionInfo } from "@paperback/types";
import info from "./MANIFOLD/pbconfig.js";

export const catalog = {
  id: "MANIFOLD",
  // SAFETY: value matches ExtensionInfo at this call site
  info: info as ExtensionInfo,
} as const;
