import type { Terminal } from "@xterm/xterm";
import type { CSSProperties, PropsWithChildren } from "react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
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
  onDoubleClick,
  onResizeStart,
  onResize,
  onResizeEnd,
  side,
}: {
  onDoubleClick?: () => void;
  onResizeStart?: () => void;
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  side: "left" | "right" | "top" | "bottom";
}) => {
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
      )}
      style={side === "left" || side === "right" ? { width: 1 } : { height: 1 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <button
        aria-label="Resize panel"
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

type MutableRef<T> = {
  current: T;
};

export const HorizontalResizablePanel = ({
  children,
  className,
  contentClassName,
  contentMinWidth,
  contentStyle,
  handleSide,
  handleVisible,
  maxWidth,
  minWidth,
  onResizeEnd,
  onResizeStart,
  onHandleDoubleClick,
  open,
  panelRef,
  style,
  transition,
  width,
  widthRef,
}: PropsWithChildren<{
  className?: string;
  contentClassName?: string;
  contentMinWidth: number;
  contentStyle?: CSSProperties;
  handleSide: "left" | "right";
  handleVisible?: boolean;
  maxWidth: number;
  minWidth: number;
  onResizeEnd?: (width: number) => void;
  onResizeStart?: () => void;
  onHandleDoubleClick?: () => void;
  open: boolean;
  panelRef?: MutableRef<HTMLDivElement | null>;
  style?: CSSProperties;
  transition: string;
  width: number;
  widthRef: MutableRef<number>;
}>) => {
  const internalPanelRef = useRef<HTMLDivElement | null>(null);

  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalPanelRef.current = node;
      if (panelRef) {
        panelRef.current = node;
      }
    },
    [panelRef],
  );

  const getPanel = useCallback(
    () => panelRef?.current ?? internalPanelRef.current,
    [panelRef],
  );

  const clampWidth = useCallback(
    (value: number) => Math.max(minWidth, Math.min(maxWidth, value)),
    [maxWidth, minWidth],
  );

  const applyWidth = useCallback(
    (nextWidth: number) => {
      widthRef.current = nextWidth;
      const panel = getPanel();
      if (!panel) {
        return;
      }

      panel.style.width = `${nextWidth}px`;
      panel.style.maxWidth = `${maxWidth}px`;
    },
    [getPanel, maxWidth, widthRef],
  );

  const handleResizeStart = useCallback(() => {
    onResizeStart?.();

    const panel = getPanel();
    widthRef.current = clampWidth(
      panel?.getBoundingClientRect().width ?? widthRef.current,
    );

    if (panel) {
      panel.style.transition = "none";
    }
  }, [clampWidth, getPanel, onResizeStart, widthRef]);

  const handleResize = useCallback(
    (deltaX: number) => {
      applyWidth(clampWidth(widthRef.current + deltaX));
    },
    [applyWidth, clampWidth, widthRef],
  );

  const handleResizeEnd = useCallback(() => {
    const panel = getPanel();
    if (panel) {
      panel.style.transition = transition;
    }

    onResizeEnd?.(widthRef.current);
  }, [getPanel, onResizeEnd, transition, widthRef]);

  useEffect(() => {
    widthRef.current = clampWidth(width);
  }, [clampWidth, width, widthRef]);

  const panel = (
    <div
      aria-hidden={!open}
      className={cn("shrink-0 overflow-hidden", className)}
      inert={!open}
      ref={setPanelRef}
      style={{
        boxSizing: "border-box",
        flex: open ? "0 0 auto" : "0 0 0px",
        maxWidth: open ? maxWidth : 0,
        minWidth: open ? minWidth : 0,
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        transition,
        width: open ? width : 0,
        willChange: "width, opacity, padding",
        ...style,
      }}
    >
      <div
        className={cn("h-full", contentClassName)}
        style={{ minWidth: contentMinWidth, ...contentStyle }}
      >
        {children}
      </div>
    </div>
  );

  const handle =
    open && (handleVisible ?? true) ? (
      <PanelResizeHandle
        onDoubleClick={onHandleDoubleClick}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        onResizeStart={handleResizeStart}
        side={handleSide}
      />
    ) : null;

  return handleSide === "left" ? (
    <>
      {handle}
      {panel}
    </>
  ) : (
    <>
      {panel}
      {handle}
    </>
  );
};

export const ToggleButton = ({
  active,
  children,
  disabled,
  highlighted,
  onClick,
  title,
}: PropsWithChildren<{
  active: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  onClick: () => void;
  title: string;
}>) => (
  <Button
    aria-label={title}
    className={cn(
      "size-8 [-webkit-app-region:no-drag]",
      active
        ? "text-foreground hover:text-foreground"
        : highlighted
          ? "text-success-highlight hover:text-success-highlight-hover"
          : "text-muted-foreground hover:text-foreground",
    )}
    disabled={disabled}
    onClick={onClick}
    size="icon"
    title={title}
    variant="ghost"
  >
    {children}
  </Button>
);

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
