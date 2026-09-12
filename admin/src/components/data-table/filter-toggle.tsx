/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { Button, cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export type FilterToggleVariant = "info" | "success" | "error" | "warning" | "neutral";

/** Toggle coloring that mirrors badge variants — tint for idle, solid for active. */
export const TOGGLE_VARIANT_STYLES = {
  info: {
    idle: "!bg-kumo-info-tint !text-kumo-info !ring-kumo-info/20",
    active: "!bg-kumo-info !text-white !ring-kumo-info",
  },
  success: {
    idle: "!bg-kumo-success-tint !text-kumo-success !ring-kumo-success/20",
    active: "!bg-kumo-success !text-white !ring-kumo-success",
  },
  error: {
    idle: "!bg-kumo-danger-tint !text-kumo-danger !ring-kumo-danger/20",
    active: "!bg-kumo-danger !text-white !ring-kumo-danger",
  },
  warning: {
    idle: "!bg-kumo-warning-tint !text-kumo-warning !ring-kumo-warning/20",
    active: "!bg-kumo-warning !text-white !ring-kumo-warning",
  },
  neutral: {
    idle: "!bg-kumo-fill !text-kumo-badge-neutral-subtle !ring-kumo-line",
    active: "!bg-kumo-badge-neutral !text-white !ring-kumo-line",
  },
} as const satisfies Record<
  FilterToggleVariant,
  { readonly idle: string; readonly active: string }
>;

export function toggleClassesForVariant(variant: FilterToggleVariant, active: boolean): string {
  const bucket = TOGGLE_VARIANT_STYLES[variant] ?? TOGGLE_VARIANT_STYLES.neutral;
  return active ? bucket.active : bucket.idle;
}

export function FilterToggle({
  active,
  variant = "neutral",
  onClick,
  children,
  className,
}: {
  readonly active: boolean;
  readonly variant?: FilterToggleVariant;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <Button
      size="sm"
      aria-pressed={active}
      variant="secondary"
      className={cn("uppercase", toggleClassesForVariant(variant, active), className)}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
