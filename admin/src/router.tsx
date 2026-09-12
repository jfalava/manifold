/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

const basepath = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

export function getRouter() {
  const router = createRouter({
    routeTree,
    basepath,
    scrollRestoration: true,
    // Show route pendingComponent immediately; default pendingMs is 1000.
    defaultPendingMs: 0,
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
