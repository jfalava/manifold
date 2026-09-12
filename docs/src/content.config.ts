/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
import { defineCollection } from "astro:content";
import {
  docsCollection,
  partialsCollection,
} from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(docsCollection()),
  partials: defineCollection(partialsCollection()),
};
