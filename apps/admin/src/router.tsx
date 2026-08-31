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
