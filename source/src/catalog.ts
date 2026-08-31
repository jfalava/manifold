import type { ExtensionInfo } from "@paperback/types";
import info from "./ManifoldSource/pbconfig.js";

export const catalog = {
  id: "ManifoldSource",
  info: info as ExtensionInfo,
} as const;
