import type { ExtensionInfo } from "@paperback/types";
import info from "./MANIFOLD/pbconfig.js";
import betaInfo from "./MANIFOLD-beta/pbconfig.js";

export const catalog = {
  id: "MANIFOLD",
  info: info satisfies ExtensionInfo,
} as const;

export const betaCatalog = {
  id: "MANIFOLD-beta",
  info: betaInfo satisfies ExtensionInfo,
} as const;
