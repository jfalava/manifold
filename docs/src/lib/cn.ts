/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics globalTimers:off */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Compose class names with Tailwind conflict resolution. Consumer class (last arg) wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
