/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/// <reference path="../.astro/types.d.ts" />

declare module "*.astro" {
  import type { AstroComponentFactory } from "astro/runtime/server/index.js";

  const Component: AstroComponentFactory;
  export default Component;
}
