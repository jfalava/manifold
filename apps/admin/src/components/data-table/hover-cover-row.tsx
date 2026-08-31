import { Table } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const ZOOM_HEIGHT = 480;

// Cover zoom is summoned only from cells marked with `data-cover-zone` — any
// other column stays quiet.
const isOverCoverZone = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest("[data-cover-zone]") !== null;

// Cover aspect ratios once known, so edge-flip math is right from pixel one
// after the first hover of a given cover.
const COVER_RATIOS = new Map<string, number>();

/**
 * Table row that shows a zoomed cover anchored to the cursor while it hovers
 * a `data-cover-zone` cell, flipped to the cursor's left side when it would
 * overflow the viewport's right edge. Pass as `renderRow` to `DataTable`.
 */
export function HoverCoverRow({
  src,
  children,
}: {
  readonly src: string | undefined;
  readonly children: ReactNode;
}) {
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Fixed-position overlays go stale on any layout shift (sidebar toggle,
  // table scroll) — dismiss instead of floating detached over wrong content.
  useEffect(() => {
    if (cursor === null || !src) {
      return undefined;
    }
    const dismiss = () => setCursor(null);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [cursor, src]);

  if (!src) {
    return <Table.Row>{children}</Table.Row>;
  }

  const ratio = COVER_RATIOS.get(src) ?? 0.7;
  const zoomWidth = ZOOM_HEIGHT * ratio;
  const flipLeft = cursor !== null && cursor.x + 16 + zoomWidth > window.innerWidth - 8;
  const left =
    cursor === null ? 0 : Math.max(8, flipLeft ? cursor.x - 16 - zoomWidth : cursor.x + 16);
  const top =
    cursor === null
      ? 0
      : Math.max(8, Math.min(cursor.y - ZOOM_HEIGHT / 2, window.innerHeight - ZOOM_HEIGHT - 16));

  return (
    <Table.Row
      onMouseEnter={(event) => {
        if (isOverCoverZone(event.target)) {
          setCursor({ x: event.clientX, y: event.clientY });
        } else {
          setCursor(null);
        }
      }}
      onMouseMove={(event) => {
        if (isOverCoverZone(event.target)) {
          setCursor({ x: event.clientX, y: event.clientY });
        } else {
          setCursor(null);
        }
      }}
      onMouseLeave={() => setCursor(null)}
    >
      {children}
      {cursor !== null &&
        createPortal(
          <img
            src={src}
            alt=""
            aria-hidden
            onLoad={(event) =>
              COVER_RATIOS.set(
                src,
                event.currentTarget.naturalWidth / event.currentTarget.naturalHeight,
              )
            }
            className="pointer-events-none fixed z-50 rounded shadow-lg ring ring-kumo-line"
            style={{
              top,
              left,
              height: ZOOM_HEIGHT,
              width: "auto",
              maxWidth: "none",
            }}
          />,
          document.body,
        )}
    </Table.Row>
  );
}
