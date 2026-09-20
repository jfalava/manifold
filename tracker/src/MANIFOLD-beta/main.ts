/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
import { ManifoldTrackerSource } from "../MANIFOLD/main.js";

/**
 * Beta channel reuses the current MANIFOLD implementation under a separate
 * Paperback extension id so it can be installed beside stable.
 */
export class ManifoldBetaExtension extends ManifoldTrackerSource {}

const MANIFOLD_BETA = new ManifoldBetaExtension();

// Paperback uses the source directory name as the extension ID. A string-named
// export keeps the `MANIFOLD-beta` spelling required by that folder name.
export { MANIFOLD_BETA as "MANIFOLD-beta" };
