/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
/** Wires Collapsible via the disclosure module. */

import { mount, makeDisclosure } from "@cloudflare/nimbus-docs/client";

function initCollapsible(root: HTMLElement): () => void {
  const trigger = root.querySelector<HTMLElement>(
    "[data-nb-collapsible-trigger]",
  );
  const content = root.querySelector<HTMLElement>(
    "[data-nb-collapsible-content]",
  );

  if (!trigger || !content) {
    return () => undefined;
  }

  const defaultOpen = root.dataset.nbDefaultOpen === "true";

  const disclosure = makeDisclosure({
    trigger,
    content,
    defaultOpen,
  });

  return () => disclosure.destroy();
}

mount("[data-nb-collapsible]", initCollapsible);
