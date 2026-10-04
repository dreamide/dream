import type { Terminal } from "@xterm/xterm";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// ── Panel resize handle ───────────────────────────────────────────────

/**
 * A draggable resize handle placed between two panels.
 *
 * `side` indicates which panel edge the handle resizes:
 * - `"right"` — the handle sits on the right edge of a left-aligned panel;
 *   dragging right increases width.
 * - `"left"` — the handle sits on the left edge of a right-aligned panel;
 *   dragging left increases width.
 * - `"bottom"` — the handle sits on the bottom edge of a top-aligned panel;
 *   dragging down increases height.
 * - `"top"` — the handle sits on the top edge of a bottom-aligned panel;
 *   dragging up increases height.
 */
export const PanelResizeHandle = ({
  className,
  onDoubleClick,
  onResizeStart,
  onResize,
  onResizeEnd,
  side,
}: {
  /** Styles the 1px line itself, e.g. to colour it and highlight on hover. */
  className?: string;
  onDoubleClick?: () => void;
  onResizeStart?: () => void;
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  side: "left" | "right" | "top" | "bottom";
}) => {
  const navigationT = useTranslations("navigation");
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);
  const lastYRef = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      lastXRef.current = e.clientX;
      lastYRef.current = e.clientY;
      onResizeStart?.();

      // Capture pointer so we get events even if cursor leaves the handle
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [onResizeStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      if (side === "left" || side === "right") {
        const delta = e.clientX - lastXRef.current;
        lastXRef.current = e.clientX;
        onResize(side === "right" ? delta : -delta);
        return;
      }

      const delta = e.clientY - lastYRef.current;
      lastYRef.current = e.clientY;
      onResize(side === "bottom" ? delta : -delta);
    },
    [onResize, side],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      onResizeEnd?.();
    },
    [onResizeEnd],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDoubleClick?.();
    },
    [onDoubleClick],
  );

  // Prevent text selection globally while dragging
  useEffect(() => {
    const onSelectStart = (e: Event) => {
      if (draggingRef.current) e.preventDefault();
    };
    document.addEventListener("selectstart", onSelectStart);
    return () => document.removeEventListener("selectstart", onSelectStart);
  }, []);

  return (
    <div
      className={cn(
        "group relative z-20 flex shrink-0 touch-none select-none items-center justify-center",
        side === "left" || side === "right"
          ? "cursor-col-resize"
          : "cursor-row-resize",
        className,
      )}
      style={side === "left" || side === "right" ? { width: 1 } : { height: 1 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <button
        aria-label={navigationT("resizePanel")}
        className={cn(
          "absolute border-0 bg-transparent p-0",
          side === "left" || side === "right"
            ? "inset-y-0 -left-1.5 -right-1.5 cursor-col-resize"
            : "inset-x-0 -top-1.5 -bottom-1.5 cursor-row-resize",
        )}
        onDoubleClick={handleDoubleClick}
        type="button"
      />
    </div>
  );
};

export const AppShellPlaceholder = ({ message }: { message: string }) => (
  <div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-sm">
    {message}
  </div>
);

export const echoPipeFallbackInput = (terminal: Terminal, data: string) => {
  let echoed = "";

  for (const char of data) {
    const code = char.charCodeAt(0);

    if (char === "\r" || char === "\n") {
      echoed += "\r\n";
      continue;
    }

    if (char === "\u007f") {
      echoed += "\b \b";
      continue;
    }

    if (code === 0x03) {
      echoed += "^C\r\n";
      continue;
    }

    if (char === "\u001b" || code < 0x20) {
      continue;
    }

    echoed += char;
  }

  if (echoed) {
    terminal.write(echoed);
  }
};
